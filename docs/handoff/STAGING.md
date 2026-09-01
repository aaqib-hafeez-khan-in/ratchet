# Staging

`ratchet-gate-staging` — https://ratchet-gate-staging.fly.dev

## Why

On 1 September five failing tests reached production: the deploy was chained
into the same command as the test run, and nothing stood between them. CI now
catches a broken **change**. This catches a broken **deploy** — a bad migration,
a missing secret, a config that only fails when the process actually boots.

```bash
npm run deploy:staging     # 1. here
npm run smoke:staging      # 2. prove it works
npm run deploy             # 3. only then production
```

## What differs from production, and why each difference is a safety property

**`AUTH_SECRET` is different.** API keys are HMACs under that secret, so a key
minted on staging is worthless in production and vice versa. Sharing it would
make two hostnames into one trust domain. Verified by digest: staging
`be5ca1e4…`, production `153304fa…`.

**No payment or chain credentials.** Staging cannot move money, because the
reliable way to be certain of that is to withhold the ability. This is visible:
staging runs **8 worker loops** and production runs **10** — `chain-watch` and
`quote-expiry` never start without Solana configuration.

**`EMAIL_PROVIDER=log`.** The queue, the dedupe window and the retry path all
run; only delivery is a no-op. Staging cannot mail a real person.

**Not indexable.** `X-Robots-Tag: noindex, nofollow, noarchive` on every
response — headers, not a meta tag, so JSON and redirects carry it too — plus a
`robots.txt` that disallows everything and points at the real service. Staging
serves a byte-identical copy of the marketing site; a search result pointing at
a half-tested build is a real cost. `config.isStaging` drives this, because
staging runs with `NODE_ENV=production` on purpose and `isProd` therefore cannot
tell them apart.

**Scales to zero.** Production keeps a machine warm because a cold start in
front of a real gate is unacceptable. In front of a smoke test it costs a second.

## One deliberate divergence: the provisioning ceiling

Staging sets `PROVISION_PER_SOURCE_PER_HOUR=200`. Production leaves it at the
default of 5.

This is the only place staging is knowingly less strict than production, and it
is worth explaining because it looks like exactly the sort of shortcut that
makes a staging environment worthless.

The smoke test provisions a workspace through the keyless path on every run —
deliberately, so a fresh deploy is exercised the way a new user meets it. At
5 an hour, the sixth deploy in an hour fails on the ceiling rather than on
anything about the build. That happened on the first day.

**A gate that fails for reasons unrelated to the thing it is gating gets
bypassed**, and a bypassed gate protects nothing. The ceiling itself is a
product behaviour and it is tested where behaviour belongs — in
`test/integration/provisioning.test.ts`, which runs in CI on every push and
asserts the real limits, including under a concurrent burst. Letting it also
throttle the deploy pipeline buys no additional confidence and costs the
pipeline's credibility.

## The database, and the compromise in it

Staging uses a separate database (`ratchet_staging`) with its own role, on the
**same Postgres cluster** as production. That is a cost decision — a second
cluster would be a second bill — and it has a real cost of its own:

> **Staging shares the production primary's CPU, memory and disk.** A load test
> here is felt there. Do not run `scripts/stress.ts` against staging while
> production is serving anyone.

What the separate role *does* remove is the far worse failure. `CONNECT` on
`ratchet_gate` has been revoked from `PUBLIC` and granted only to the production
role, so the staging credential cannot open a connection to the production
database at all. Verified both directions:

```
staging role -> ratchet_staging  CONNECTED
staging role -> ratchet_gate     FATAL: permission denied for database
```

Note the order that made that safe: `GRANT` to the production role first, then
`REVOKE` from `PUBLIC`. Reversed, there is a window where production cannot
connect to its own database.

## The smoke test

`scripts/smoke.mjs` deliberately holds no credential. It provisions a workspace
through the keyless path and drives the real lifecycle with it — begin, replay,
report, replay again — so a fresh deploy is exercised the way a new user meets
it. It checks, in the order these things have actually broken:

1. The process boots and reaches **its own** database.
2. Migrations ran.
3. The gate decides correctly, and a recorded outcome replays verbatim.
4. Nothing indexable escaped.

It is not vacuous: pointed at production it fails on the noindex check, which is
the assertion most likely to rot.

## The order is enforced

`npm run deploy` runs four gates before it will touch production, ordered so a
failure is discovered as cheaply as possible:

1. **Clean and pushed.** Whatever is live must be something you — or somebody
   else, in six months — can check out and reproduce.
2. **CI is green for this exact commit.**
3. **Staging is running this exact commit.** Not a similar one, not yesterday's.
4. **The staging smoke test passes right now**, against that build.

Gate 3 needs to know what staging is running, so the image records the commit it
was built from as `GIT_COMMIT`. That value is deliberately **not served on any
public endpoint**: the repository is open, and publishing the exact deployed
commit tells anyone who asks precisely which fixes an instance is missing. The
script reads it through `flyctl`, which is authenticated. Staging scales to
zero, so it is woken first — a suspended machine otherwise looks identical to a
staging app that was never deployed, and the refusal would send you to fix the
wrong thing.

**The escape hatch is `npm run deploy:force`.** A separate command rather than a
flag, because refusing to deploy during an incident is its own outage, and
because a flag can be reached by habit.

Demonstrated end to end: with staging on an older build the deploy refused at
gate 3; after `npm run deploy:staging` it passed all four and shipped.

## Known gaps
- Staging has no separate uptime monitoring; it is expected to be down between
  deploys.
- Resource contention with production, above.
