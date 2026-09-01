#!/usr/bin/env bash
# Ship the repository itself off-machine, beside the database backups.
#
# The database already has two independent backups. The CODE had exactly one
# copy that was not this laptop: GitHub. That is a single account, a single
# vendor, and a single password-reset email away from being unavailable — and
# the database backups are worthless without the code that understands the
# schema.
#
# A git bundle is the right primitive: ONE file containing the complete history
# of every branch and tag, restorable with `git clone <file>`. It carries only
# committed objects, so .env and anything else gitignored cannot leak into it by
# construction — which is why this is safe to store beside the data.
#
#   scripts/snapshot-code.sh [outdir]
set -euo pipefail

OUT=${1:-./backups}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT"

command -v git >/dev/null || { echo "  git is required"; exit 1; }

BUNDLE="$OUT/ratchet-code-$STAMP.bundle"
echo "  bundling every branch and tag…"
git bundle create "$BUNDLE" --all >/dev/null 2>&1

# A bundle that cannot be read back is not a backup. Verify before shipping.
git bundle verify "$BUNDLE" >/dev/null 2>&1 || { echo "  bundle failed verification"; exit 1; }
COMMITS=$(git rev-list --all --count)
echo "  bundle: $BUNDLE ($(wc -c < "$BUNDLE" | tr -d ' ') bytes, $COMMITS commits, verified)"

# Guard against the one way a secret could ever reach this file: someone
# committing it in the past. Bundles carry history, so a deleted secret is
# still in there.
if git log --all --oneline -- .env 2>/dev/null | head -1 | grep -q .; then
  echo "  REFUSING TO UPLOAD: .env appears in git history."
  echo "  The bundle carries history, so the secret would travel with it."
  echo "  Purge it first (git filter-repo) and rotate whatever it contained."
  exit 1
fi

if [ -n "${TIGRIS_ACCESS_KEY_ID:-}" ] && [ -n "${TIGRIS_BUCKET:-}" ]; then
  echo "  uploading off-machine…"
  node scripts/s3-put.mjs "$BUNDLE" "code/ratchet-code-$STAMP.bundle"
else
  echo "  (TIGRIS_* not set — bundle kept locally only)"
fi

# Keep the local copies bounded; the off-machine copy is the durable one.
ls -1t "$OUT"/ratchet-code-*.bundle 2>/dev/null | tail -n +6 | xargs -r rm -f
echo "  done."
