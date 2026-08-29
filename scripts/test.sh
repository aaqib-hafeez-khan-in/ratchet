#!/usr/bin/env bash
# Runs the full suite against a disposable Postgres database.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${RATCHET_DB_PORT:-5433}
export DATABASE_URL="postgres://ratchet:ratchet@127.0.0.1:${PORT}/ratchet_test"
export NODE_ENV=test

bash scripts/dev-db.sh up >/dev/null

# Recreate the test database so every run starts from a known schema.
docker exec ratchet-pg psql -U ratchet -d postgres -q \
  -c "DROP DATABASE IF EXISTS ratchet_test WITH (FORCE);" \
  -c "CREATE DATABASE ratchet_test;" >/dev/null

echo "→ typecheck"
npx tsc -p tsconfig.json --noEmit

echo "→ unit"
node --test --import tsx "test/unit/"*.test.ts

# Integration and e2e files share one database and the worker's queue sweeps
# are global by design, so files run one at a time. Tests within a file still
# exercise real concurrency directly (see concurrency.test.ts).
echo "→ integration"
node --test --test-concurrency=1 --import tsx "test/integration/"*.test.ts

echo "→ e2e"
node --test --test-concurrency=1 --import tsx "test/e2e/"*.test.ts
