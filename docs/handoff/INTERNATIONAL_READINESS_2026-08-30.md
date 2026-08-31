# International readiness — 2026-08-30

Prompted by: "is the service ready for all types of agents from everywhere in the world?
Will there be any conflicts in our service?"

Everything below was tested against a running instance, not reasoned about.

## Defects found and fixed

### 1. Unicode normalisation — the gate could be defeated by platform, not by logic

The same visible string has several legal encodings. `café` is one code point on Linux and
Windows (NFC) and two on macOS (NFD). Idempotency keys were compared as raw bytes, so:

- Two agents in one fleet, one on a Mac and one on Linux, gating **the same action** with
  **the same key** both received `execute`. The customer was charged twice. This is precisely
  the failure the product exists to prevent, and it was reachable by any customer whose keys
  contain a non-ASCII character — a name, a city, an invoice label in any language but English.
- A retry whose *payload* was equivalently encoded was rejected as `idempotency_key_reuse`,
  telling an honest caller they had made a mistake and blocking work that should have proceeded.

Fixed by normalising to NFC at every point a caller-supplied identifier is compared:
`beginEffect`, `lookupEffect`, the payload fingerprint (values **and** object keys), and
`group_key` at all four of its SQL binding sites. NFC is what W3C and Unicode Annex #15
recommend for identifiers; it merges only canonically equivalent sequences, so nothing
semantically distinct is collapsed. `effect_type` needed no change — its schema pattern is
ASCII-only. An ASCII fast path keeps normalisation off the hot path for the common case.

Regression coverage: `test/integration/unicode.test.ts` (8 tests).

### 2. Budget windows are UTC, and never said so

`utcDay()` buckets spend by UTC calendar day — the right call, since a local-time window would
need a per-workspace timezone and would still have no good answer for the two days a year a DST
zone has 23 or 25 hours. But a customer in Tokyo sees their "daily" budget reset at 09:00 local,
one in Los Angeles at 17:00, and `budget_exceeded` said nothing about when the window reopened.
An agent could not tell whether to wait thirty seconds or twenty hours.

`budget_exceeded` now carries `resetsAt`, the exact ISO instant. The reasoning is documented at
the function.

### 3. Server-locale number formatting in customer-facing copy

`toLocaleString()` with no argument uses the *container's* locale. Had the host booted `de-DE`,
emails and the pricing copy would have rendered `250.000` where English prose says `250,000`.
Pinned to `en-US` across `meta.ts`, `billing.ts`, and `email-templates.ts`, matching the language
of the surrounding copy.

### 4. Orphaned favicon fragment on all six pages

`<text y='16' font-size='16'>⚙️</text></svg>">` — the tail of an inline SVG favicon whose opening
was replaced when `mark.svg` was introduced. An unknown element in `<head>` ends the head and
opens the body early. Removed from all pages.

## Verified working

- **Non-ASCII input**: Japanese, Arabic (RTL), Cyrillic, emoji, combining marks, zero-width
  joiners, and Devanagari all work as idempotency keys, and are correctly recognised as the same
  effect on repeat.
- **Timestamps** are `timestamptz` and returned as UTC ISO throughout.

## Known limits, not defects

- **USD only.** Stripe Checkout is created in USD; crypto quotes are USD-pegged. International
  cards work — the issuer does the conversion — but the customer carries the FX spread and sees
  a USD line on their statement. No local pricing, no VAT/GST handling.
- **Single region (`sjc`).** `begin` sits on the critical path before every gated action, so a
  European caller pays roughly 150ms of round trip and an Asian caller more. This is not
  fixable by edge caching: the gate is a lock, it must be strongly consistent, and a stale
  read is the one thing it must never serve. Multi-region would need either regional
  partitioning by workspace or a consensus store.
- **English only.** No localised copy, emails, or error messages.
- **US data residency.** Database and application both run in the US. There is no EU-resident
  option, which is a live question for GDPR-sensitive buyers.
