# What to do when Ratchet is unreachable

Ratchet sits in front of your side effects. That makes it a dependency in your critical path, and
you are entitled to know exactly what happens to your agents when it is unavailable.

This page states that plainly. **Decide this before you integrate, not during an incident.**

---

## The choice, in one line

When `begin` cannot be reached, your agent must either **act without the gate** (fail-open) or
**refuse to act** (fail-closed). There is no third option, and the right answer depends entirely
on the effect.

| | Fail-open | Fail-closed |
|---|---|---|
| Behaviour | Perform the effect anyway | Skip the effect; surface the outage |
| Risk you accept | A duplicate | Work not done, delayed, or lost |
| Correct for | Idempotent vendors; harmless duplicates; low-value actions | Charges, payouts, irreversible or externally-visible actions |
| Rule of thumb | The duplicate costs less than the delay | The duplicate costs more than the delay |

**Ratchet's own default recommendation is fail-closed for anything you would have to apologise
for, and fail-open for everything else.** That mirrors the `on_indeterminate` policy you already
configure per effect type — and it should usually match it.

---

## Fail-closed (recommended for money and messages)

```python
try:
    gate = ratchet.begin(effect_type="payment.charge",
                         idempotency_key=f"invoice:{period}:{account_id}",
                         payload={"cents": amount})
except RatchetUnavailable:
    # We cannot prove this has not already happened. Do not charge.
    raise HoldForRetry(
        "Cannot verify charge state — the effect gate is unreachable. "
        "Queued for retry; no charge attempted."
    )

if gate.decision != "execute":
    return handle(gate)

charge()
ratchet.report(gate, outcome="succeeded", result={...})
```

The work is not lost — it is deferred. Retry with the **same idempotency key** and the gate resolves
it correctly once reachable.

## Fail-open (acceptable when the vendor is idempotent)

```python
try:
    gate = ratchet.begin(effect_type="http.post",
                         idempotency_key=f"sync:{record_id}:{version}",
                         payload=body)
    if gate.decision != "execute":
        return handle(gate)
    token = gate.lease_token
except RatchetUnavailable:
    # The vendor deduplicates on its own key, so a duplicate is harmless.
    log.warning("effect gate unreachable; proceeding ungated", extra={"key": key})
    token = None

post_to_vendor(body, idempotency_key=key)   # vendor-side dedupe still applies
if token:
    ratchet.report(gate, outcome="succeeded", result={...})
```

Only choose this when a duplicate is genuinely harmless. "Probably fine" is not an analysis.

---

## Client requirements

1. **Set a short timeout.** 2–3 seconds is generous; the gate's own decision path is a few
   milliseconds plus your network round trip. A long timeout converts a Ratchet outage into an
   agent hang.
2. **Do not retry `begin` more than briefly.** One or two quick retries with jitter is right.
   Beyond that you are queueing, not gating.
3. **Treat a timeout as unreachable, not as a decision.** A timed-out `begin` may still have created
   the effect. Re-calling with the same key is safe and idempotent — that is the entire design.
4. **Never invent a decision.** If you cannot reach the gate, you have no decision. Choose your
   configured fallback; do not guess `execute`.
5. **Report late rather than never.** If `report` fails, retry it. A lease that lapses unreported
   becomes `indeterminate`, which is recoverable but requires human verification.

---

## What Ratchet guarantees during partial failure

| Failure | Behaviour | Consequence |
|---|---|---|
| Worker down, API up | Lease expiry still happens inline on the next `begin` for that key | Correct, just less timely; webhooks pause |
| API up, database down | `begin` fails; `/readyz` reports not ready | Your fallback applies |
| Network partition mid-`begin` | Effect may or may not exist | Re-call with the same key — safe by construction |
| Network partition mid-`report` | Lease may lapse | Effect becomes `indeterminate`; resolve it |
| Ratchet fully down | No decisions available | Your fallback applies |

**A lease that is never reported is never silently resolved.** That property holds through every
failure above; it is the one thing the service will not compromise.

---

## Current availability posture — stated plainly

At the time of writing this deployment is **single-region with a single primary database and no
automatic failover** (see `handoff/KNOWN_LIMITATIONS.md` §4). There is **no SLA**.

If your effects are high-value, choose fail-closed and accept that a Ratchet outage pauses that
work — or do not put Ratchet in that path yet. We would rather say this than have you discover it
during an incident.
