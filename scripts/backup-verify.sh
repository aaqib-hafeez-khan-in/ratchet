#!/usr/bin/env bash
# Take a logical backup of production and PROVE it restores.
#
# An untested backup is a hypothesis. This dumps the live database, restores it
# into a throwaway Postgres of the same major version, compares row counts, and
# re-verifies every receipt signature and chain link against the public key the
# live service publishes — no server secret involved, which is exactly what an
# auditor would have.
#
#   scripts/backup-verify.sh [outdir]
set -euo pipefail

PG_APP=${PG_APP:-ratchet-gate-pg}
DB=${DB:-ratchet_gate}
BASE=${BASE:-https://ratchetgate.com}
OUT=${1:-./backups}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
CONTAINER=ratchet-restore-$STAMP
PORT=${PORT:-5456}

mkdir -p "$OUT"

for tool in flyctl docker node; do
  command -v "$tool" >/dev/null || { echo "  missing required tool: $tool"; exit 1; }
done

# The dump format version tracks the SERVER major version, so the restore side
# must be equal or newer. A Postgres 18 dump cannot be read by 16 tooling —
# found the hard way.
#
# Errors are NOT swallowed here. This probe used to redirect stderr to
# /dev/null, so when flyctl could not reach the app — a bad token, no
# wireguard, the wrong org — `set -e` killed the script with no output at all
# and a failed nightly backup looked like a mystery. A backup that fails must
# say why; that is most of its job.
PROBE=$(flyctl ssh console -a "$PG_APP" \
  -C "sh -c 'PGPASSWORD=\$OPERATOR_PASSWORD psql -h $PG_APP.internal -U postgres -d $DB -At -c \"SHOW server_version\"'" \
  2>&1) || {
    echo "  could not reach $PG_APP over flyctl ssh. Raw output:"
    echo "$PROBE" | sed 's/^/    /'
    echo "  Most likely: FLY_API_TOKEN is missing, expired, or not scoped to this app."
    exit 1
  }
MAJOR=$(printf '%s' "$PROBE" | tr -d '\r' | grep -oE '^[0-9]+' | head -1)
if [ -z "$MAJOR" ]; then
  echo "  could not read the server version. Raw output:"
  printf '%s' "$PROBE" | sed 's/^/    /'
  exit 1
fi
echo "  production server: $MAJOR"

# Check we can actually write to the bucket BEFORE dumping and restoring.
#
# Three runs in a row failed only at the very end: once on a missing module,
# once on bucket permissions — each time after ninety seconds of dumping
# production, pulling a Postgres image and verifying 443 receipts. Discovering
# a credential problem at the last step is the most expensive possible moment.
if [ -n "${TIGRIS_ACCESS_KEY_ID:-}" ] && [ -n "${TIGRIS_BUCKET:-}" ]; then
  echo "  checking write access to the bucket…"
  PROBE_KEY="preflight/.write-check"
  PROBE_FILE=$(mktemp)
  printf 'ratchet backup preflight' > "$PROBE_FILE"
  if ! node scripts/s3-put.mjs "$PROBE_FILE" "$PROBE_KEY" >/dev/null 2>&1; then
    echo "  cannot write to bucket \"$TIGRIS_BUCKET\"."
    echo "  Check, in the Tigris console:"
    echo "    - the bucket exists and is spelled exactly that way"
    echo "    - the access key has read/write on it (not another bucket)"
    echo "    - TIGRIS_ACCESS_KEY_ID and TIGRIS_SECRET_ACCESS_KEY are from the SAME key pair"
    rm -f "$PROBE_FILE"
    exit 1
  fi
  rm -f "$PROBE_FILE"
  echo "  bucket is writable."
fi

echo "  dumping…"
flyctl ssh console -a "$PG_APP" \
  -C "sh -c 'PGPASSWORD=\$OPERATOR_PASSWORD pg_dump -h $PG_APP.internal -U postgres -d $DB -Fc -f /tmp/b.dump'" >/dev/null
( cd "$OUT" && flyctl ssh sftp get /tmp/b.dump -a "$PG_APP" >/dev/null && mv b.dump "ratchet-$STAMP.dump" )
DUMP="$OUT/ratchet-$STAMP.dump"
echo "  dump: $DUMP ($(wc -c < "$DUMP") bytes)"

echo "  restoring into a throwaway postgres:${MAJOR}-alpine…"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=test -p "$PORT:5432" \
  "postgres:${MAJOR}-alpine" >/dev/null
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 40); do docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done
docker cp "$DUMP" "$CONTAINER:/tmp/r.dump" >/dev/null
docker exec "$CONTAINER" psql -U postgres -c "CREATE DATABASE restored" >/dev/null
docker exec "$CONTAINER" pg_restore -U postgres -d restored --no-owner --no-privileges /tmp/r.dump

echo "  verifying evidence in the restored copy…"
node scripts/verify-restore.mjs "postgres://postgres:test@127.0.0.1:$PORT/restored" "$BASE"

# Only upload AFTER the restore verified. Shipping an unverified dump off-site
# manufactures confidence in a file nobody has proven can be restored.
if [ -n "${TIGRIS_ACCESS_KEY_ID:-}" ] && [ -n "${TIGRIS_BUCKET:-}" ]; then
  echo "  uploading the verified dump off-machine…"
  node scripts/s3-put.mjs "$DUMP" "postgres/ratchet-$STAMP.dump"
else
  echo "  (TIGRIS_* not set — dump kept locally only)"
fi
