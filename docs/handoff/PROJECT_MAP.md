# Project map

Where everything lives and what it is responsible for. Update when structure changes.

## Inherited state

The repository was **empty** at handoff. There was no Antigravity, Codex, or Cursor code, no
scaffolding, no schema, no configuration, and no git history — an `ls -a` showed only `.` and `..`.
Nothing was preserved, migrated, or removed, because there was nothing to preserve. Every file
here was written in this pass. This is recorded plainly because the brief anticipated an
inherited codebase; treating an empty directory as if it contained prior work would have been
the first inaccurate claim in the project.

## Source

| Path | Responsibility |
|---|---|
| `src/api/app.ts` | Fastify factory: security headers, CORS, rate limiting, error shape, OpenAPI, static web, route registration |
| `src/api/server.ts` | Process entrypoint. Refuses unsafe production config, migrates, listens, drains on SIGTERM |
| `src/api/schemas.ts` | JSON Schemas shared by request validation and the generated OpenAPI document |
| `src/api/serialize.ts` | The single conversion point between the camelCase domain and the snake_case wire format |
| `src/api/plugins/auth.ts` | `requireKey` (API key + scopes) and `requireConsole` (session cookie or key) |
| `src/api/routes/effects.ts` | begin · report · resolve · cancel · approval · reads |
| `src/api/routes/workspace.ts` | signup · workspace · keys · policies · webhooks · ledger · audit |
| `src/api/routes/billing.ts` | plans · checkout · test settlement · signature-verified provider webhook |
| `src/api/routes/meta.ts` | health · readiness · agent manifest · llms.txt |
| `src/domain/effects.ts` | **The state machine.** All decision logic lives here |
| `src/domain/policy.ts` | Per-effect-type rules and safe defaults |
| `src/domain/budget.ts` | External-spend ceilings (the customer's money at third parties) |
| `src/domain/metering.ts` | Ratchet's own billing: allowance, overage, credit ledger |
| `src/domain/plans.ts` | Plan definitions and limits |
| `src/domain/billing.ts` | Payment-provider boundary: test adapter, signature verification, event application |
| `src/domain/auth.ts` | Keys, scopes, workspaces, console sessions |
| `src/domain/events.ts` | Webhook fan-out and idempotent enqueue |
| `src/domain/audit.ts` | Audit trail writes and reads |
| `src/db/pool.ts` | Connection pool, transaction helper, bigint parsing |
| `src/db/migrate.ts` | Advisory-locked migration runner; safe with concurrent boots |
| `src/db/migrations/001_init.sql` | Complete schema with rationale comments |
| `src/mcp/tools.ts` | Tool definitions, written for an LLM reader. Shared by both transports and the manifest |
| `src/mcp/protocol.ts` | JSON-RPC handling: initialize, tools/list, tools/call, ping, batches |
| `src/mcp/handlers.ts` | Tool dispatch into the same domain functions the REST API uses |
| `src/mcp/http.ts` | Streamable HTTP transport, stateless and per-request authorised |
| `src/mcp/stdio.ts` | stdio transport for locally spawned MCP clients |
| `src/lib/config.ts` | Environment inventory and `assertProductionSafety()` |
| `src/lib/errors.ts` | `ApiError` and the stable error-code catalogue |
| `src/lib/ids.ts` | Identifiers, hashing, constant-time compare, canonical fingerprinting |
| `src/lib/ssrf.ts` | Address classification, URL validation, DNS re-resolution and pinning |
| `src/worker/main.ts` | Non-overlapping interval loops with failure isolation |
| `src/worker/reaper.ts` | Lease expiry, retention GC, stale-record cleanup |
| `src/worker/webhooks.ts` | Signed delivery with SSRF re-checks, backoff, dead-lettering |

## Web

Static HTML and ES modules. No build step, no framework, no bundler.

| Path | Page |
|---|---|
| `web/index.html` + `assets/home.js` | Landing page |
| `web/docs.html` + `assets/docs.js` | Integration documentation |
| `web/pricing.html` + `assets/pricing.js` | Plans, rendered from the live `/v1/billing/plans` |
| `web/security.html` | Security posture |
| `web/console.html` + `assets/console.js` | Operator console |
| `web/assets/style.css` | One stylesheet; light and dark via `prefers-color-scheme` |
| `web/assets/partials.js` | Shared header, footer, tabs, highlighting, escaping |

Page scripts are external files, not inline. The CSP is `script-src 'self'` with no
`unsafe-inline`, and it is enforced — inline scripts were silently blocked until they were moved
out, which is exactly what the policy is for.

## Tests

| Path | Layer |
|---|---|
| `test/unit/ssrf.test.ts` | Address classification and URL validation boundaries |
| `test/unit/canonical.test.ts` | Payload fingerprint determinism |
| `test/unit/stripe-signature.test.ts` | HMAC verification, tampering, replay window |
| `test/unit/webhook-signing.test.ts` | Outbound signature construction |
| `test/integration/effects.test.ts` | Full state machine, all policy modes, fencing, cancellation |
| `test/integration/concurrency.test.ts` | Races, single-winner guarantee, budget atomicity |
| `test/integration/isolation.test.ts` | Tenant isolation, key authentication, scopes |
| `test/integration/billing.test.ts` | Metering, allowance, overage, ledger, period rollover |
| `test/integration/webhooks.test.ts` | Signing, dedupe, retry classification, dead-lettering |
| `test/integration/ssrf-delivery.test.ts` | Delivery-time SSRF refusal under production config |
| `test/e2e/api.test.ts` | HTTP surface: onboarding, core loop, auth, validation, headers |
| `test/e2e/mcp.test.ts` | Both MCP transports, handshake, scopes, decision guidance |
| `test/e2e/limits.test.ts` | Rate limiting and body size limits |
| `test/helpers.ts` | Per-test workspace isolation; env overrides use `??=` so files can set strict config |

## Scripts

| Path | Purpose |
|---|---|
| `scripts/dev-db.sh` | Local Postgres in Docker |
| `scripts/test.sh` | Recreates the test database, then runs all layers |
| `scripts/seed.ts` | Realistic workspace state for the console |
| `scripts/bench.ts` | Gate latency percentiles |
| `scripts/bench-budget.ts` | Latency with budget enforcement active |
| `scripts/emit-openapi.ts` | Writes `/openapi.json` to disk |

## Deployment

| Path | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build; one image, two entrypoints; non-root; tini for signal handling |
| `docker-compose.yml` | Database + control plane + worker, reproducible locally |
| `.env.example` | Complete environment inventory with safety notes |
