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

# The dump format version tracks the SERVER major version, so the restore side
# must be equal or newer. A Postgres 18 dump cannot be read by 16 tooling —
# found the hard way.
MAJOR=$(flyctl ssh console -a "$PG_APP" \
  -C "sh -c 'PGPASSWORD=\$OPERATOR_PASSWORD psql -h $PG_APP.internal -U postgres -d $DB -At -c \"SHOW server_version\"'" \
  2>/dev/null | tr -d '\r' | grep -oE '^[0-9]+' | head -1)
echo "  production server: ${MAJOR:-unknown}"

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
