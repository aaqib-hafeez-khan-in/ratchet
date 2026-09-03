# ratchet-mcp

MCP server for [Ratchet](https://ratchetgate.com) — an effect gate for AI agents.

Agents retry. LLM control flow is non-deterministic, network calls fail ambiguously, and processes
die mid-action, so the same logical action gets attempted zero, one, or several times and nothing
knows which. Ratchet is a gate you ask **before** acting, and it answers durably.

## Setup

Get a key at <https://ratchetgate.com/console> (free, no card), then:

```json
{
  "mcpServers": {
    "ratchet": {
      "command": "npx",
      "args": ["-y", "ratchet-mcp"],
      "env": { "RATCHET_API_KEY": "rk_live_..." }
    }
  }
}
```

Put the key in `env`, never in `args` — arguments are visible in process listings.

Works with Claude Desktop, Claude Code, Cursor, and any MCP client that spawns a stdio server.

**Runs on macOS, Linux, Windows and BSD** — anywhere Node 18+ runs. The bridge is a single
dependency-free file with no native modules, no shell-outs and no platform-specific paths, so there
is nothing to compile and nothing that behaves differently between operating systems. Ratchet
itself is a hosted service, so the gate is never something you install or operate.

## Tools

| Tool | What it does |
|---|---|
| `ratchet_begin_effect` | Ask permission before a side effect. Returns `execute`, `duplicate`, `in_flight`, `blocked`, `approval_required`, or `denied` |
| `ratchet_report_effect` | Report the outcome after acting |
| `ratchet_get_effect` | Ask "did I already do this?" without reserving anything |
| `ratchet_resolve_effect` | Settle an effect whose outcome was unknown, after verifying |
| `ratchet_list_effects` | Review recent effects; filter by `indeterminate` to find unresolved work |
| `ratchet_get_policy` | Read the retry and budget policy for an effect type |
| `ratchet_get_usage` | Plan, allowance, credit balance, and today's spend |

Only `execute` authorises the model to act. Every other decision returns a `next_step` beginning
with `STOP`.

## The part that matters

If your agent dies between "go" and "done", Ratchet does **not** quietly let the next caller retry.
The lease expires, the effect becomes `indeterminate` — a known unknown — and your configured
policy for that effect type decides what happens: block (the default), retry, or verify first.

Exactly-once delivery is not achievable and is not claimed. What is guaranteed is at-most-once
initiation, a recorded outcome that later callers replay, and an explicit state for the case most
systems bury.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RATCHET_API_KEY` | *(required)* | Your scoped API key |
| `RATCHET_BASE_URL` | `https://ratchetgate.com` | Point at your own instance |
| `RATCHET_TIMEOUT_MS` | `15000` | Request timeout |

This package holds no database connection and no server secret — only your key, which is scoped
and revocable. It is a thin bridge to the HTTP API, with zero dependencies.

If the gate is unreachable it returns a JSON-RPC error rather than crashing, so your agent can
apply its fail-open or fail-closed policy. Decide which **before** integrating:
<https://ratchetgate.com/docs>

## License

Apache-2.0
