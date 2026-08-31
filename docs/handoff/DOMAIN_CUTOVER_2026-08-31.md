# Domain cutover — ratchetgate.com

`ratchet-gate.fly.dev` → `ratchetgate.com`, done 2026-08-31 while there were zero registered
OAuth clients and zero customers with the old host in their code. That timing was the point: the
switch rewrites the OAuth issuer and every snippet `/v1/integrate` emits, so doing it later means
breaking working integrations inside other people's companies.

## DNS

Cloudflare, **DNS-only (grey cloud)** on all four records. Fly issues and terminates its own TLS
via these records; proxying breaks ACME validation, and enabling it later without switching to
Full (strict) leaves an unverified Cloudflare→Fly leg.

```
A     @    66.241.125.158
AAAA  @    2a09:8280:1::17e:f585:0
A     www  66.241.125.158
AAAA  www  2a09:8280:1::17e:f585:0
```

Fly validates ownership through the **AAAA** record. An A record alone leaves the certificate at
`Not verified` indefinitely, with no error that says so.

Note that `flyctl certs list` reported `Issued` for a hostname that `flyctl certs show` reported
as `Not verified`. `show` is authoritative; the list is not.

## What moved with PUBLIC_URL

`PUBLIC_URL` is the single source of the service's identity, so one secret carried all of:
the OAuth issuer and every advertised endpoint, the `resource_metadata` in the `/mcp` 401
challenge, the audience tokens are bound to, `BASE` in every `/v1/integrate` recipe, `llms.txt`,
the agent manifest, and `security.txt`.

Deployed with `--stage` so the secret and the code landed in one restart.

## The redirect, and its carve-out

Page views on the old host 301 to the new one. **GET and HEAD only, and never for API paths**
(`/v1/`, `/mcp`, `/oauth/`, `/.well-known/`, `/healthz`, `/readyz`, `/openapi.json`, `/llms.txt`).

A 301 on a POST is downgraded to GET by some clients. That would turn a gated `begin` into a page
fetch and hand the caller a decision nobody made — a silent correctness failure in the one code
path the product exists to protect. Tested directly.

The old hostname keeps serving the API indefinitely rather than being retired.

## security.txt

`/.well-known/security.txt` was a 404 before this. It is generated per request rather than
static: RFC 9116 requires an `Expires` field, and a lapsed one reads as abandoned, which is worse
than having none. Always six months out, asserted by test.

## Still open

- **Email.** Resend needs SPF/DKIM/DMARC on `mail.ratchetgate.com` — a subdomain, so alert volume
  cannot poison the root domain's deliverability for invoices and human replies. `EMAIL_FROM`
  already defaults to `alerts@mail.ratchetgate.com`.
- **Inbound aliases** via Cloudflare Email Routing: `security@` (referenced by security.txt and
  currently a promise we cannot keep), `support@`, `billing@`, `abuse@`, `postmaster@`, `hello@`.
- **`www`** — certificate was still validating at cutover; apex was serving correctly throughout.

---

## Live services as of 2026-08-31

**Email.** `mail.ratchetgate.com` verified with Resend; SPF, DKIM and DMARC all published and
valid. Sending confirmed end to end — a real message reached `security@ratchetgate.com` through
Cloudflare Email Routing. All six aliases live (`security`, `support`, `billing`, `abuse`,
`postmaster`, `hello`), no catch-all.

Two things worth remembering. A single hard bounce put the recipient on Resend's suppression list
and the next send was refused before it was attempted; clearing it needs a DELETE against
`/suppressions`. And Cloudflare routing rules take up to a minute to propagate — a correct rule
returns `550 Address does not exist` for its first minute, which looks exactly like a broken one.
`RCPT TO` over SMTP with no `DATA` is a safe way to check without generating a bounce.

DMARC is `p=none` with reports going to both Cloudflare's parser and `security@`. Tighten to
`quarantine`, then `reject`, once reports show only Resend sending as us.

**Stripe.** Live keys deployed; a real `cs_live_` checkout session was created to prove the live
key is the one in use, rather than trusting the configuration. The webhook destination subscribes
to six events — `checkout.session.completed`, the three `customer.subscription.*`, plus
`charge.refunded` and `charge.dispute.created`. The last two matter: without them a refunded or
disputed customer keeps both the credit and their money.

Signature verification confirmed in both directions: unsigned and forged requests are refused
with 400, a genuine Stripe test event is accepted with 200 and correctly applies nothing.

Note that Stripe's newer "event destinations" UI offers **Snapshot** and **Thin** payloads. This
handler reads `mode`, `metadata`, and `payment_intent` off the event object, so it requires
Snapshot. A Thin destination would deliver IDs only and every event would fail.

## Still outstanding

- `ratchet-mcp` is not published to npm; no GitHub remote exists. Both block MCP directory
  submissions, and both need the operator's accounts.
- Resend has only `mail.ratchetgate.com` verified. Sending *as* `security@ratchetgate.com` — for
  replying to vulnerability reports from the published address rather than a personal Gmail —
  needs the root domain verified as a second Resend domain.
- Several throwaway workspaces created on production during billing verification.
