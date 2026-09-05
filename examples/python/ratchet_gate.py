# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos LLC
"""
Ratchet — minimal Python integration.

Dependencies: httpx (or swap in requests; nothing here is httpx-specific).

The point of this file is the `gate` context manager. Wrap any side effect in
it and the retry semantics become correct by construction.
"""
from __future__ import annotations

import contextlib
import os
from dataclasses import dataclass
from typing import Any, Iterator

import httpx

BASE = os.environ.get("RATCHET_BASE_URL", "http://localhost:8787")
KEY = os.environ["RATCHET_API_KEY"]


class AlreadyDone(Exception):
    """The effect already completed. `result` is the recorded outcome."""

    def __init__(self, result: Any) -> None:
        super().__init__("effect already completed")
        self.result = result


class NotPermitted(Exception):
    """Ratchet refused: in_flight, blocked, approval_required, or denied."""

    def __init__(self, decision: str, reason: str, effect_id: str) -> None:
        super().__init__(f"{decision}: {reason}")
        self.decision = decision
        self.reason = reason
        self.effect_id = effect_id


@dataclass
class Lease:
    effect_id: str
    lease_token: str
    attempt: int
    result: Any = None
    cost_micros: int | None = None

    def record(self, result: Any, cost_micros: int | None = None) -> None:
        """Record what the action produced. Replayed to future duplicate callers."""
        self.result = result
        self.cost_micros = cost_micros


class Ratchet:
    def __init__(self, base: str = BASE, key: str = KEY, timeout: float = 10.0) -> None:
        self._c = httpx.Client(
            base_url=f"{base}/v1",
            headers={"authorization": f"Bearer {key}"},
            timeout=timeout,
        )

    def _post(self, path: str, body: dict) -> dict:
        r = self._c.post(path, json=body)
        if r.status_code >= 400:
            err = r.json().get("error", {})
            raise RuntimeError(f"ratchet {err.get('code')}: {err.get('message')}")
        return r.json()

    @contextlib.contextmanager
    def gate(
        self,
        effect_type: str,
        idempotency_key: str,
        payload: dict | None = None,
        *,
        estimated_cost_micros: int = 0,
        agent_id: str | None = None,
        run_id: str | None = None,
        lease_seconds: int | None = None,
    ) -> Iterator[Lease]:
        """
        Gate a side effect.

        Raises AlreadyDone if the action already completed (catch it and use
        `.result`). Raises NotPermitted for every other non-execute decision.

        On a clean, provable failure inside the block, the effect is reported
        as `failed` so a later attempt is permitted. On any other exception the
        effect is left UNREPORTED on purpose: we do not know whether the action
        reached the outside world, and claiming otherwise is how duplicates and
        lost work happen. The lease lapses and Ratchet records `indeterminate`.
        """
        body: dict[str, Any] = {
            "effect_type": effect_type,
            "idempotency_key": idempotency_key,
            "payload": payload or {},
            "estimated_cost_micros": estimated_cost_micros,
        }
        if agent_id:
            body["agent_id"] = agent_id
        if run_id:
            body["run_id"] = run_id
        if lease_seconds:
            body["lease_seconds"] = lease_seconds

        gate = self._post("/effects/begin", body)
        decision = gate["decision"]

        if decision == "duplicate":
            raise AlreadyDone(gate.get("result"))
        if decision != "execute":
            raise NotPermitted(decision, gate.get("reason", ""), gate["effect_id"])

        lease = Lease(gate["effect_id"], gate["lease_token"], gate["attempt"])
        try:
            yield lease
        except DidNotHappen as exc:
            self._post(
                f"/effects/{lease.effect_id}/report",
                {"lease_token": lease.lease_token, "outcome": "failed",
                 "failure_reason": str(exc)[:1024]},
            )
            raise
        except Exception:
            # Deliberately silent. An unreported lease becomes `indeterminate`,
            # which is the honest state when the outcome is genuinely unknown.
            raise
        else:
            report: dict[str, Any] = {
                "lease_token": lease.lease_token,
                "outcome": "succeeded",
                "result": lease.result,
            }
            if lease.cost_micros is not None:
                report["actual_cost_micros"] = lease.cost_micros
            self._post(f"/effects/{lease.effect_id}/report", report)


class DidNotHappen(Exception):
    """
    Raise this ONLY when you are certain the side effect never reached the
    outside world — a validation error before the request was sent, a refusal
    with a definitive error code. Never for a timeout or a dropped connection.
    """


# --------------------------------------------------------------------- usage

if __name__ == "__main__":
    ratchet = Ratchet()

    def send_welcome_email(user_id: str, address: str) -> dict:
        try:
            with ratchet.gate(
                "email.send",
                f"welcome:{user_id}",          # deterministic: same work, same key
                {"to": address, "template": "welcome"},
                estimated_cost_micros=800,
                agent_id="onboarding-agent",
            ) as lease:
                # ---- the real side effect goes here ----
                message_id = "msg_" + user_id
                lease.record({"message_id": message_id}, cost_micros=780)
                return {"sent": True, "message_id": message_id}

        except AlreadyDone as done:
            # Not an error. Someone already did this; reuse the outcome.
            return {"sent": False, "replayed": True, **(done.result or {})}

        except NotPermitted as stop:
            if stop.decision == "blocked":
                raise RuntimeError(
                    f"A previous attempt to email {user_id} may or may not have gone out. "
                    f"Check the mail provider, then resolve effect {stop.effect_id}."
                ) from stop
            raise

    print(send_welcome_email("u_9001", "sam@example.com"))
    print(send_welcome_email("u_9001", "sam@example.com"))  # replayed, not re-sent
