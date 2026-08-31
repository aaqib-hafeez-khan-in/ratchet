# Surge containment (the circuit breaker)

*Added 31 August 2026. Migration 022. `src/domain/circuit.ts`.*

## The gap it fills

Budget ceilings stop an agent spending too much money. Nothing stopped an agent
doing too **much**.

The two are not the same failure. A retry loop that sends five thousand emails
instead of three may cost nothing at all — every individual action is cheap,
authorised, and indistinguishable from correct work. `max_cost_micros` does not
see it. `daily_budget_micros` does not see it. Only the *rate* gives it away.

Ratchet is the one place that can see the rate, because every intended side
effect passes through the gate *before* it happens. A surge can be caught while
it is still three emails in.

## What it does

Per effect type, a workspace may set `surge_per_hour`. When new effects of that
type exceed it, the breaker opens.

An open breaker **raises the effective policy mode**. That is the whole design:
it reuses the state machine rather than adding to it, so `awaiting_approval`,
the approval endpoints, receipts, and events all work unchanged.

| `surge_action` | Effect when open |
|---|---|
| `monitor` | Records the trip and emits `circuit.tripped`. **Changes no decision.** |
| `require_approval` *(default)* | The work waits for a human. The agent is not killed. |
| `deny` | Refused outright. |

### Why the default is not a hard stop

A blocked agent loses its work and its context. A *waiting* agent keeps both,
and a human decides. Nothing irreversible happens in between. An operator who
genuinely wants the agent dead can choose `deny`; one who wants to watch before
enforcing anything can choose `monitor`.

`monitor` exists because a containment feature that fires wrongly is worse than
none, and nobody should have to find that out in production.

## It is off by default, and that is deliberate

`surge_per_hour` defaults to NULL, which disables it entirely. Every existing
workspace was created without this setting, and none of them may start being
refused because a new feature shipped. The first test in
`test/integration/circuit.test.ts` asserts exactly that.

## Design decisions worth keeping

**Only new effects count.** Duplicates, retries, and in-flight checks are not new
work in the real world. Counting them would let a caller hammering one stuck
action trip its own breaker — punishing precisely the behaviour the gate asks
for.

**Closing grants a fresh allowance, measured from a baseline.** The first
implementation had a real flaw: the hourly count is cumulative, so once a
workspace went over, the breaker re-tripped on *every* subsequent effect until
the hour rolled over, and `surge_cooldown_seconds` meant nothing. Closing now
records the count it cleared at, and the surge is measured from there. The raw
counters are untouched, so the rate history an operator reads to choose a
threshold stays accurate. A second surge still trips it again — clearing resets
the allowance, it does not disarm the breaker.

**No foreign key to `workspaces`** on `effect_rate_windows` or
`circuit_breakers`. These are written inside the decision transaction, which
already holds the workspace row exclusively; a foreign key would take a KEY
SHARE lock on that same row. Receipts learned this in migration 016, where the
FK turned a 43 ms concurrency test into 1021 ms. Orphans are collected by the
reaper.

**Nothing an agent sends can reach the decision.** The threshold is stored
policy; the count is database state. A breaker an agent could talk its way past
would be worse than no breaker at all — CLAUDE.md §5.6, tested directly.

**`deny` outranks `require_approval` outranks `monitor`.** The workspace-wide
stop cannot be softened by a laxer per-type breaker.

## The emergency stop

`POST /v1/circuits/*/open` halts **every** effect type in the workspace.

A breaker opened by hand has **no cooldown**. It stays open until a human closes
it, because a control someone reached for in a panic must not quietly undo
itself while they sleep.

These routes require a console session or an admin key — never the key-only path
that `begin` and `report` use. An agent that can close its own breaker has not
been stopped, and `test/e2e/circuits.test.ts` asserts an agent key is refused.

The open route carries a deliberately generous rate limit (120/min). Refusing
someone's emergency stop because they clicked twice would be indefensible.

## Measured cost

`scripts/bench.ts 800`, three runs, Apple M5 Pro against local Postgres:

```
before:  begin (new effect)  p50=2.52ms  p95=3.16
after:   begin (new effect)  p50=2.96ms  p95=3.57   (3 runs: 3.01 / 2.95 / 2.96)
```

About **0.45 ms on new effects only** — one UPSERT into `effect_rate_windows`.
Duplicates, replays, and reports are untouched, which is the path a retrying
agent actually takes.

The counter runs even when no threshold is configured. That is a deliberate
trade: without rate history nobody can choose a threshold, so the feature would
be unconfigurable and would do nothing useful on the day someone turned it on.

`npm run stress 4` — all safety properties still hold.

## API

```
GET  /v1/circuits                      breakers + per-type volume to set a threshold against
POST /v1/circuits/:effectType/open     {action?, reason}   — "*" for the whole workspace
POST /v1/circuits/:effectType/close    fresh allowance, breaker still armed
PUT  /v1/policies/:effectType          {surge_per_hour, surge_action, surge_cooldown_seconds}
```

MCP: `ratchet_circuit_status` (read-only). Its description tells the model to
stop rather than work around a breaker — not to rename the effect type, split
across keys, or vary the idempotency key.

## Not done yet

- **No learned baseline.** Thresholds are absolute, chosen by the operator from
  the reported peak. A relative rule ("10× the trailing 7-day median") would
  catch surges on workspaces that never configured anything, but it needs
  history this has only just started collecting, and a wrong automatic threshold
  refuses real work.
- **The trip emits `circuit.tripped`** as a webhook event; there is no email on
  it yet. An operator with no webhook configured learns about a trip only from
  the console or the blocked agent's report.
- **Hourly windows only.** A burst inside one minute that stays under the hourly
  ceiling passes.
