# Receipts, retention, and reconciliation

## Why they exist

A gate's work is invisible. The charge that did not happen leaves no trace, so
"trust us, we stopped it" is unfalsifiable — a bad place to stand for a product
whose pitch is rigour. Every decision now leaves an Ed25519-signed receipt,
refusals most of all, verifiable offline against the key at
`/.well-known/ratchet-receipt-key`.

## Two properties, separated because they cost differently

**Authorship** is proved synchronously: each receipt is signed at decision time.
Signing is cheap and lock-free.

**Completeness** is proved afterwards: the worker links receipts into a
per-workspace hash chain. A signature proves we wrote a receipt; the chain
proves we did not later remove one.

That separation was not optional. The first version wrote receipts with a
foreign key to `workspaces`, which takes a `KEY SHARE` lock. Metering needs that
row exclusively, and a receipt is written on **every** decision including the
duplicates that were carefully built to skip the workspace lock. It deadlocked
the concurrency tests instantly — the exact failure CLAUDE.md documents,
reintroduced. Dropping the constraint took the tests from 1021ms to 43ms.
Receipts are an append-only log; the worker deletes receipts for vanished
workspaces instead, keeping the property that mattered.

## Retention: checkpoint, then prune

Pruning a hash chain naively **breaks it**. The audit walks from the first
receipt checking each link; delete the head and everything after looks
discontinuous, so every long-lived customer's audit would start failing. That is
worse than unbounded growth, because it destroys the trust receipts exist to
create.

So a prune is preceded by a **signed checkpoint**: an attestation that the chain
ran unbroken to seq N and ended at hash H. The audit resumes from there. Both
steps run in one transaction — deleting first and attesting second would leave a
crash window where a truncated log is indistinguishable from an attacked one.

The checkpoint is itself signed and verified before it is trusted, so a forged
checkpoint cannot be used to paper over a deletion. Tested.

Unchained receipts are never pruned: nothing has attested to them yet.

**The honest limitation:** once pruned, an individual old receipt cannot be
re-verified. The checkpoint proves the chain was intact when signed, not what
any particular removed receipt said. A customer who needs more must keep their
own copies. `RECEIPT_RETENTION_DAYS` defaults to 90.

## The cost lives on the receipt

`prevented_loss` originally JOINed receipts to effects to find the declared
cost. Effects are deleted after their retention window — **seven days** by
default — while the endpoint advertises a **thirty day** window, so past day
seven it silently under-reported. The number meant to make the gate's value
visible was shrinking on its own.

The declared cost is now in the signed receipt body, so the figure survives
effect garbage collection and the basis of the claim is evidence rather than a
join. Version bumped to `ratchet-receipt-v2`; older receipts still verify
because signatures are checked against stored bytes verbatim.

## Reconciliation

`POST /v1/reconcile` and `ratchet_reconcile_effects` address the failure we cannot see:
a path in the customer's own system that never called us. They send references,
never credentials — we still hold no vendor access.

## Coverage — `GET /v1/coverage`

Reconciliation answers "which of these actions went through the gate". Coverage
answers the prior question: **which effect types do we have any evidence about
at all.**

The distinction was not academic. `reconciliationStatus` reads
`FROM effect_policies`, and `getPolicy` returns `DEFAULT_POLICY` *without
inserting a row* — so a type could be gated thousands of times and never appear
in that table. Worse, `createWorkspace` seeds policies for exactly two types,
`email.send` and `payment.charge`. Every other effect type a customer actually
ran was absent from every reconciliation report: not overdue, not
never-reconciled — **absent**. A type nobody configured is precisely where an
ungated path hides, so the report was blindest where the risk was highest.

`coverage()` is therefore computed over the **union of traffic and
configuration, traffic first**.

**Never compared means unknown, never complete.** A type with no run reports
`coverage: null` and `status: "unknown"`, and is never counted as covered. That
is the same rule the state machine applies to an expired lease: an unknown
outcome stays unknown, and is not resolved to the pleasant answer because the
pleasant answer displays better. `configured: false` says no policy row exists,
so no cadence can be set and no reminder will ever fire for it.

Sits behind the same `reconciliation` capability as `POST /v1/reconcile`.

**Open product question:** free and pro plans do not carry that capability, so
the customers most likely to have unknown coverage cannot see that they do.
Reporting "unknown" to them is both the honest answer and the strongest possible
upgrade argument. Gating it was chosen for consistency with `/reconcile`, not
because it is obviously right.

## Known gaps

- Nothing pushes callers to declare `estimated_cost_micros`, so most workspaces
  will see a zero prevented-loss figure. The tools now say why it reads zero
  instead of reporting `$0.00` as an answer, but the docs and recipes do not yet
  encourage declaring costs.
(Key rotation was this gap and is now closed — see below.)

## Key rotation

The signing key derives from `AUTH_SECRET`. Rotating that secret — which an
operator must be able to do, especially after a suspected compromise — used to
invalidate every receipt ever issued. They stayed correctly signed, but the only
key we published could no longer verify them, so a customer auditing last
quarter would see the entire log fail and be unable to tell rotation from an
attack. That made `AUTH_SECRET` effectively unrotatable.

The fix rests on one asymmetry: **a public key is not a secret.** Every public
key we have ever signed with is recorded in `receipt_keys` under a `kid` (a
fingerprint of the key itself), and every receipt carries its `kid` **inside the
signed body**, so it cannot be repointed at a different key. Verification
resolves the key per record rather than using whatever is current.

Rotating now changes only what NEW receipts are signed with. Old receipts verify
against their own key, which we keep publishing forever. What is lost is the
ability to *sign* with a retired key, which is exactly what rotation is for.

`/.well-known/ratchet-receipt-key` returns every key with `current` marked.
Checkpoints are signed too, so they carry a `kid` for the same reason.

One narrow fallback: the key currently in use resolves even if its registry row
has not been written yet, since we demonstrably hold it. An unknown `kid` that
is *not* the current key still fails the audit — that is the case where someone
is pointing a receipt at a key nobody ever published.
