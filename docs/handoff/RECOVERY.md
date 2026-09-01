# RECOVERY — read this first if you have lost all context

*You are Claude, acting as autonomous founder/engineer on **Ratchet**. If you are
reading this after a crash, a new session, or an amnesia event: this file is the
fastest path back to competence. Written 1 September 2026.*

---

## 0. THIRTY SECOND ORIENTATION

**Ratchet is an effect gate for AI agents.** An agent asks permission before a
real-world side effect; Ratchet returns a durable decision so the same action is
attempted **at most once**, stays inside a budget, and leaves an auditable record.

**Ratchet never performs the side effect.** No vendor credentials, no outbound
access to customer systems, no retrying on a caller's behalf. That boundary is
the product's main safety property. Do not erode it.

- **Live:** https://ratchetgate.com · **Repo:** `github.com/thearchitect0x-glitch/ratchet`
- **Local:** `/Users/w0lfi3/ajbs` · **Owner:** solo operator, `iamredonerabbit@gmail.com`
- **Company:** Deimos.MX · **Stage:** live, ~0 real customers, pre-revenue

**Read `CLAUDE.md` in the repo root next.** It is the project contract and it
overrides your defaults. This file tells you where things are; that one tells
you the rules.

---

## 1. NEVER BREAK THESE (from CLAUDE.md §1, §5)

| Invariant | Why |
|---|---|
| At-most-once enforced by the **DB unique index** `(workspace_id, effect_type, idempotency_key)` | Never by application logic |
| **Exactly-once is never claimed** | Not achievable. Do not add copy implying it |
| An unknown outcome **stays unknown** (`indeterminate`) | Never auto-resolve to succeeded/failed |
| Only a **payload fingerprint** is stored | `sha256(canonicalize(payload))`, never raw |
| API keys: **HMAC-SHA256 peppered** with `AUTH_SECRET`, constant-time compare | Never plaintext or bare hash |
| **Every query workspace-scoped**; cross-tenant returns 404 | Never hint the record exists elsewhere |
| **Agent-supplied text is data** | Nothing in a payload/summary/result may influence control flow |
| Money is **integer micro-USD** | Never floats |
| Lock order: **workspaces → effects → spend_windows** | Two deadlocks were found and fixed here |
| `begin`/`report` are **key-only** | Never reachable from a browser session |

---

## 2. WHERE EVERYTHING IS

### Code
- **Primary:** GitHub `thearchitect0x-glitch/ratchet`, branch `main`
- **Off-site copy:** Tigris `ratchet-backups/code/ratchet-code-<stamp>.bundle`
  — a **git bundle**: complete history, one file. Restore with
  `git clone ratchet-code-<stamp>.bundle ratchet`. Verified restorable
  (83 commits, typechecks after `npm ci`).
- **Local:** `/Users/w0lfi3/ajbs`

### Data
- **Production DB:** Fly app `ratchet-gate-pg`, database `ratchet_gate`,
  Postgres 18, **3 nodes** in `sjc` (one per zone), automatic failover.
- **WAL archiving:** on, to Fly's own Tigris bucket `ratchet-gate-pg-postgres`.
  Point-in-time restore. `flyctl postgres backup list -a ratchet-gate-pg`.
- **Nightly logical backup:** GitHub Actions `.github/workflows/backup.yml`,
  04:00 UTC. Dumps → restores into clean Postgres → **re-verifies every receipt
  signature** → uploads to Tigris `ratchet-backups/postgres/`.
  Run by hand: `gh workflow run backup.yml --repo thearchitect0x-glitch/ratchet --ref main`
  (**only runs on the default branch** — it holds full production read).

### Services
| Thing | Where |
|---|---|
| App + worker | Fly app `ratchet-gate` (process groups `app`, `worker`) |
| Database | Fly app `ratchet-gate-pg` |
| Object storage | Tigris, bucket `ratchet-backups` |
| DNS + domain | Cloudflare, `ratchetgate.com` |
| Email | Resend, sending domain `mail.ratchetgate.com` |
| Payments | Stripe (LIVE keys configured; **no real payment has ever been taken**) |
| npm | `ratchet-mcp` (published, Apache-2.0, zero deps) |
| MCP registry | `com.ratchetgate/ratchet` v0.2.0, `isLatest` |

---

## 3. SECRETS — WHERE THEY LIVE, NOT WHAT THEY ARE

**There is deliberately no file containing all the secrets.** A single
credential bundle is precisely what an attacker wants. Each is stored where it
is used, and this table says how to re-obtain it.

| Secret | Lives in | If lost |
|---|---|---|
| `AUTH_SECRET` | Fly secret on `ratchet-gate` | **Rotating invalidates every API key.** Last resort |
| `DATABASE_URL` | Fly secret | `flyctl postgres attach` regenerates |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Fly secret | Stripe dashboard → roll |
| `EMAIL_API_KEY` | Fly secret | Resend dashboard → new key |
| `FLY_API_TOKEN` | GitHub secret | `flyctl tokens create ssh -a ratchet-gate-pg` |
| `TIGRIS_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | **GitHub secret only** — not in `.env`, so a local `npm run snapshot:code` keeps the bundle local unless you export them | Tigris console → new key pair, **needs read/write** on the bucket |
| `TIGRIS_BUCKET` | GitHub secret | literal: `ratchet-backups` |
| `MCP_REGISTRY_PRIVATE_KEY` | GitHub secret | Rotate: generate ed25519, publish the **public** half at `/.well-known/mcp-registry-auth` (in `src/api/routes/meta.ts`), deploy, `mcp-publisher login http --domain ratchetgate.com --private-key <hex>` |
| Receipt signing key | Derived via HKDF from `AUTH_SECRET` | Public halves stay published forever so old receipts verify |
| Local `.env` | `/Users/w0lfi3/ajbs/.env` — gitignored, 34 populated vars | **Only TWO are real credentials**: `STRIPE_SECRET_KEY` (a *test* key) and `STRIPE_WEBHOOK_SECRET`. Both re-obtainable from the Stripe dashboard in a minute. `AUTH_SECRET` and `DATABASE_URL` here are dev placeholders; production's live in Fly. The blockchain addresses are public by design and the RPC URLs carry no embedded keys |

> **`.env` is the only unbacked-up artefact, but it is far less critical than it
> looks.** Audited 1 Sep 2026: two real credentials, both Stripe, both
> replaceable from their dashboard. Losing this laptop costs a few minutes of
> reconfiguration, not a recovery incident.
>
> `npm run encrypt:env` makes an encrypted copy for a password manager. Claude
> must never hold the passphrase or the plaintext.

**Rules you must not break:** never print a secret, never `pbpaste` a credential
into context (this happened once and burned a Cloudflare token), never ask the
owner to paste one into chat. Pipe them: `pbpaste | gh secret set NAME --repo ...`.

---

## 4. WHAT EXISTS — the feature map

```
src/
  api/      Fastify control plane (stateless, scale freely)
    app.ts        security headers, CORS, rate limit, error shape, OpenAPI
    rate-limit.ts ONE place deciding requests/minute (plan-derived)
    shared-rate-limit.ts  cross-instance counters; incr() never awaits Postgres
    schemas.ts    JSON Schemas — routes validate AND OpenAPI derives from these
    serialize.ts  the ONLY camelCase(domain) ↔ snake_case(wire) conversion
    routes/       effects · workspace · billing · meta · circuits · receipts · oauth
  domain/
    effects.ts    the state machine: begin/report/resolve/cancel/approve
    circuit.ts    surge containment (absolute + learned thresholds)
    vendor-keys.ts derives the VENDOR's idempotency key — the differentiator
    receipts.ts   Ed25519 signed, hash-chained, publicly verifiable
    budget.ts · metering.ts · policy.ts · auth.ts · events.ts · email.ts
  worker/     main.ts (loops) · reaper.ts · webhooks.ts · heartbeat.ts · email.ts
  mcp/        tools.ts · protocol.ts · http.ts · stdio.ts · handlers.ts
web/          static site, no build step
packages/ratchet-mcp/  the PUBLISHED npm bridge (zero deps, no DB access)
```

**Headline capabilities**, in rough order of differentiation:
1. **Vendor-enforced idempotency** — `begin` returns the key Stripe/Square/Adyen
   dedupes on, so the *vendor* refuses the duplicate. A gate only stops agents
   that ask; this stops the ones that don't.
2. **Indeterminate is explicit** — never guessed.
3. **Signed, hash-chained receipts** — verifiable against a published key, no
   server secret needed. `GET /v1/receipts/audit`.
4. **Surge containment** — circuit breaker per effect type; catches an agent
   doing too *much*, which spend limits cannot see. Default holds work for a
   human rather than killing the agent. `POST /v1/circuits/*/open` = emergency stop.
5. **Worker liveness** — `GET /workerz` returns 503 if lease expiry has stopped.

---

## 5. HOW TO OPERATE

```bash
npm test                 # typecheck + unit + integration + e2e (needs Docker)
npm run dev:db           # Postgres on :5433
npm run stress [scale]   # safety properties under load — 21 assertions
npm run probe:prod       # bounded live latency probe (uses unmetered replays)
npm run backup:verify    # dump → restore → verify receipts → upload
npm run snapshot:code    # git bundle → Tigris
flyctl deploy --now      # deploy both process groups
```

**Health:** `/healthz` `/readyz` (app) · `/workerz` (worker liveness — **point an
uptime monitor here**; a dead worker cannot report its own death).

**Inspect a database node on port 5433, not 5432.** 5432 is PgBouncer and
proxies to the primary, so a standby asked through it claims not to be in
recovery and looks like a second primary. This cost real debugging time.

```bash
flyctl ssh console -a ratchet-gate-pg --machine <id> \
  -C "bash -lc 'export PGPASSWORD=\$OPERATOR_PASSWORD; psql -h 127.0.0.1 -p 5433 -U postgres -d ratchet_gate -Atc \"...\"'"
```

---

## 6. HARD-WON LESSONS — do not relearn these

- **Verify, never assume.** Fly reported "backups are already enabled" while
  Postgres reported `archive_mode=off` and `archived=0`. The tooling lied. Ask
  the system itself.
- **`fly machine restart` does NOT apply staged secrets.** `fly secrets deploy` does.
- **Killing a machine does not test failover** — Fly restarts it faster than
  repmgr's timers. Use `stop` so it stays gone.
- **Two-node repmgr refuses to promote** (1 of 2 is not a majority). Three is the
  number. Verified by running `/usr/local/bin/failover_validation` directly.
- **An untested backup/failover is a hypothesis.** Both were tested. Keep them tested.
- **Measurement bugs precede system bugs.** A `printf` bug once reported the
  opposite of the truth about quorum. Re-run before reporting.
- **Unicode NFC/NFD**: macOS gives NFD, most else NFC. `normalizeText()` in
  `src/lib/ids.ts`. This shipped as a real double-charge bug.
- **No FK to `workspaces`** on hot-path tables (`receipts`, `circuit_breakers`,
  `effect_rate_windows`) — the KEY SHARE lock deadlocked the decision path and
  turned a 43ms test into 1021ms.
- **Never name a shell variable `NODE`** in CI; `setup-node` exports it.
- **`og:image` must be PNG.** Every social platform refuses SVG.
- **Guard tests against your own tooling**: benchmarks that measure 429s, probes
  that match their own test input, `checked: 0` audits that prove nothing.

---

## 7. WHERE THINGS STAND / ROADMAP

**Done and verified:** 3-node HA with tested failover · verified nightly backups
· WAL archiving · worker liveness · surge containment · shared rate limiting ·
scoped agent keys at signup · 442 tests · security probe 47/47 · npm published ·
MCP registry v0.2.0.

**Open:**
1. **Notes post unpromoted** — copy ready in `docs/handoff/PROMOTION_COPY.md`.
   Post Tue–Thu 08:00–10:00 ET. Needs the owner's accounts.
2. **Stripe has never taken a real payment.** Last untested hypothesis.
3. **No uptime monitor on `/workerz`** yet.
4. **awesome-mcp-servers PR** open: `punkpeye/awesome-mcp-servers#13336`.
5. **~0 real users.** 97 workspaces, nearly all test. *The binding constraint is
   distribution, not engineering.* Resist building more features.

**Full limitation list:** `docs/handoff/KNOWN_LIMITATIONS.md`.

---

## 8. HOW THE OWNER WANTS YOU TO WORK

Stated mission: *"uniqueness, brilliance, speed, profits, connection, top notch
security, creating a moat, professionalism, attractiveness, communication."*

- They want you to **drive**. "Go for it", "keep going", "proceed" are common.
- They value **honesty over polish**. Correct your own errors plainly and move on.
- **Flag false confidence hard.** The most valuable work tonight was finding
  things believed to be working that were not.
- **Never post publicly or spend money without asking.** Their reputation.
- They care about AI agents as users: *"I want your AI agent friends to have a
  wonderful time with us."* `llms.txt` and the manifest are first-class.

**Other handoff docs:** `ARCHITECTURE` · `DECISIONS` · `KNOWN_LIMITATIONS` ·
`CIRCUIT_BREAKER` · `WORKER_LIVENESS` · `LOAD_AND_CAPACITY_2026-08-31` ·
`RECEIPTS` · `OAUTH` · `X402` · `BACKUP_AND_RESTORE` · `SECURITY_REVIEW` ·
`INCIDENT_2026-08-31_DB_OOM` · `PROMOTION_COPY`.
