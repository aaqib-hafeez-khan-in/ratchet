# Backup and restore — tested, not assumed

## Result

A logical dump of production was taken, restored into a clean Postgres, and
verified. **All six tables matched exactly**, and **all 119 receipts across 37
chains re-verified against the published public key** — zero failures on body
hashes, signatures, or chain links.

```
                RESTORED   PRODUCTION
api_keys              64           64
audit_events         157          157
effects               94           94
oauth_clients         15           15
receipts             119          119
workspaces            62           62
```

That second check is the one that matters. Matching row counts prove the rows
came across; re-verifying the signatures proves the **evidence is still
evidence**. It uses only the key the live service publishes, so it is exactly
the check an auditor could run against us.

`npm run backup:verify` does the whole thing and fails loudly if any part does.

## What the test found that assumption would not have

**A Postgres 18 dump cannot be restored by Postgres 16 tooling.** The first
attempt failed with `unsupported version (1.16) in file header`. The dump format
tracks the server major version, so the restore side must be equal or newer.
Anyone reaching for whatever `pg_restore` is on their laptop during an incident
will hit this at the worst possible moment. The script now reads the production
major version and spins up a matching container.

## What is still missing

**Continuous backup is OFF.** `fly pg backup enable -a ratchet-gate-pg` creates
a Tigris bucket and requires agreeing to Tigris's Terms of Service, which is the
operator's decision, not something to accept on their behalf. Without it there
is no point-in-time recovery — only volume snapshots.

**Volume snapshots**: retention raised from 5 to 30 days, scheduled snapshots
on. A snapshot restores the whole volume, not a table or a moment.

**The database is a single machine with no replica.** Fly's own message on every
command is worth repeating: *"Unmanaged Fly Postgres is not supported by Fly.io
Support and users are responsible for operations, management, and disaster
recovery."* If that machine and its volume are lost together, the snapshot is
the only thing left.

**Off-machine storage is live.** The verified dump is uploaded to Tigris
(`ratchet-backups/postgres/`) as the final step of `npm run backup:verify`.
Order matters: the upload runs only AFTER the restore has verified, because
shipping an unverified dump off-site manufactures confidence in a file nobody
has proven restorable.

The uploader is a hand-written SigV4 signer rather than the AWS SDK or CLI. This
repo keeps nine production dependencies deliberately, and a backup script that
only runs where somebody remembered to install the AWS CLI is a backup script
that will not run when it matters. The implementation is checked against AWS's
published SigV4 test vector.

Credentials live in the operator's shell environment at mode 600, never in the
repo. The dump contains every workspace, key hash, and receipt in production, so
the bucket must be treated as production data; dumps are gitignored.

**Nothing schedules it yet.** `npm run backup:verify` still has to be run by
someone, and nothing alerts if it stops running.

## Recommended order

1. `flyctl pg backup enable -a ratchet-gate-pg --yes` (operator accepts the ToS)
2. Schedule `npm run backup:verify` somewhere that alerts on failure
3. Add a replica, or move to a managed Postgres, before real customer data lands
