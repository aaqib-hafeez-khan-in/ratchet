# Promotion copy — "Your idempotency keys are broken on macOS"

*Prepared 1 September 2026. Everything below needs a human to post it: these are
accounts under your name, and the judgement about your reputation is yours.*

URL: `https://ratchetgate.com/notes/idempotency-keys-are-broken-on-macos`

---

## Post one place first

Resist posting everywhere at once. If it lands on Hacker News you will want to
be present for the comments; if it sinks, you learn something before spending
the other venues. **Hacker News first.**

**Timing matters more than the copy.** HN is a US-weekday-morning site.

The operator is on **US Pacific**, so in local terms:

| Pacific | Eastern | Verdict |
|---|---|---|
| 05:00–07:00 | 08:00–10:00 | Prime. Best odds of the front page |
| 07:00–08:00 | 10:00–11:00 | Still strong |
| 08:00–09:00 | 11:00–12:00 | Fine. Traffic holds through the US workday |
| after 12:00 | after 15:00 | Declining — the day's stories are established |

**06:00–07:00 Pacific is the practical pick**: inside the prime window without
setting a 05:00 alarm. Tuesday to Thursday. Avoid Friday and the weekend.

*(An earlier draft of this file said "Sunday night" and then gave Eastern times
to a Pacific reader. Both were wrong.)*

---

## 1. Hacker News

Submit as a **link**, not Show HN — Show HN is for things people can try, and
this is an article.

**Title** (use the article's own title; HN dislikes editorialised ones):

```
Your idempotency keys are broken on macOS
```

**First comment** — post one immediately. HN convention, and it declares the
conflict of interest before someone else does:

```
Author here. This is on our own site and we sell a product in this area, so
take the context for what it is — but the bug is real, it was ours, and it had
shipped.

The short version: macOS filesystems hand you NFD-normalised strings, almost
everything else hands you NFC. "café" is 5 bytes one way and 6 the other, and
both render identically. If you compare idempotency keys as raw bytes — which
is the obvious thing to do — two machines can send what a human would call the
same key and get two authorisations for the same work.

The fix is one normalisation call at the boundary. The part that took longer was
realising the payload fingerprint had the inverse problem: normalising there
would make genuinely different payloads look identical.

Happy to answer anything about the failure modes.
```

**What to expect:** the top comment will probably be "this is just Unicode
normalisation, everyone knows this." The honest answer is that everyone knows it
exists and approximately nobody normalises their idempotency keys — which is why
it shipped here too. Don't get defensive; that comment is right and also proves
the point.

---

## 2. Reddit — r/programming

Link post, same title. Read the current self-promotion rules first; r/programming
removes company links that read as marketing. This one survives on the
technical content, but only if you engage in comments rather than dropping and
leaving.

Skip r/webdev (wrong audience) and r/devops (wrong layer).

---

## 3. Lobsters

Only if you have an account — it's invite-only and its self-promotion norms are
stricter than HN's. Tag `unicode` and `practices`.

---

## 4. X / LinkedIn

```
Unicode can spell "café" two ways. 5 bytes or 6, rendering identically.

macOS filesystems give you one. Postgres and web forms give you the other.

Compare idempotency keys as raw bytes and two machines can each be told
"execute" for the same work. Same invoice, charged twice.

We found this in our own code, after it shipped:
https://ratchetgate.com/notes/idempotency-keys-are-broken-on-macos
```

The link now renders a proper preview card — `og:image` was an SVG until
1 September, which every one of these platforms silently refuses to display.

---

## What NOT to do

- **Do not post from multiple accounts or ask anyone to upvote.** HN detects
  voting rings and the penalty is a domain ban — you would lose ratchetgate.com
  as a submittable domain permanently.
- **Do not lead with the product.** The article earns attention because it is a
  real bug with a reproducible demonstration. The product is the footer.
- **Do not submit the same URL twice** if the first attempt sinks. HN treats
  reposts of the same URL as a duplicate.
