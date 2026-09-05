#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos LLC
# Runs the full suite against a disposable Postgres database.
set -euo pipefail
cd "$(dirname "$0")/.."

# --coverage runs unit + integration under c8 instead of the full three suites.
# It lives here rather than as its own npm script because the database setup
# below is the whole point: the coverage run used to invoke the suites directly
# with no DATABASE_URL of its own, so it ran against the development database
# and inherited whatever rows were already there. That produced failures with
# no relationship to the change being measured, three times in one afternoon.
COVERAGE=0
[ "${1:-}" = "--coverage" ] && COVERAGE=1

PORT=${RATCHET_DB_PORT:-5433}
export DATABASE_URL="postgres://ratchet:ratchet@127.0.0.1:${PORT}/ratchet_test"
export NODE_ENV=test

# On a developer's machine Postgres is a Docker container this script starts and
# reaches with `docker exec`. In CI it is a service container that is already
# running and has no name we can exec into, so the same work is done over the
# wire with psql. One script, so CI cannot drift from what people run locally.
ADMIN_URL="postgres://ratchet:ratchet@127.0.0.1:${PORT}/postgres"

if [ "${CI:-}" = "true" ]; then
  for i in $(seq 1 30); do
    pg_isready -h 127.0.0.1 -p "$PORT" -U ratchet >/dev/null 2>&1 && break
    sleep 1
  done
  psql "$ADMIN_URL" -q \
    -c "DROP DATABASE IF EXISTS ratchet_test WITH (FORCE);" \
    -c "CREATE DATABASE ratchet_test;" >/dev/null
else
  bash scripts/dev-db.sh up >/dev/null
  # Recreate the test database so every run starts from a known schema.
  docker exec ratchet-pg psql -U ratchet -d postgres -q \
    -c "DROP DATABASE IF EXISTS ratchet_test WITH (FORCE);" \
    -c "CREATE DATABASE ratchet_test;" >/dev/null
fi

echo "→ typecheck"
npx tsc -p tsconfig.json --noEmit
# test/ and scripts/ are outside the build config's rootDir, so they were
# never checked. A required field added to a domain type could go missing
# from a fixture and only surface at runtime.
npx tsc -p tsconfig.test.json

if [ "$COVERAGE" = "1" ]; then
  # All three suites, not just unit and integration. Files like mcp/handlers.ts
  # and api/routes/oauth.ts are exercised almost entirely by e2e, so leaving it
  # out reported them at 9% and 23.7% and understated the whole figure by ten
  # points — the mirror of the earlier bug, where test files were in the
  # denominator and overstated it by six.
  #
  # --include, not --src: c8 counts every file it loads, so `--src src` alone
  # left all 69 test files being measured. They run themselves, scored 99.79%,
  # and pulled the number up while the code they cover sat lower.
  #
  # Thresholds: 90 on statements and lines because the OpenSSF gold answer
  # claims 90%, and a floor beneath a published claim lets the claim quietly
  # become false. Branches jitter by a few hundredths between runs, so 78
  # leaves room for that and not for a regression.
  #
  # Comments cannot go inside the continued command below; they become
  # arguments and c8 prints its help instead of running.
  echo "→ unit + integration + e2e, measured"
  exec npx c8 --reporter=text-summary --reporter=lcov --all \
    --include "src/**" \
    --exclude "src/db/migrations/**" --exclude "src/**/types.ts" \
    --check-coverage \
    --statements 90 --branches 78 --lines 90 --functions 88 \
    node --test --test-concurrency=1 --import tsx \
      "test/unit/"*.test.ts "test/integration/"*.test.ts "test/e2e/"*.test.ts
fi

echo "→ unit"
node --test --import tsx "test/unit/"*.test.ts

# Integration and e2e files share one database and the worker's queue sweeps
# are global by design, so files run one at a time. Tests within a file still
# exercise real concurrency directly (see concurrency.test.ts).
echo "→ integration"
node --test --test-concurrency=1 --import tsx "test/integration/"*.test.ts

echo "→ e2e"
node --test --test-concurrency=1 --import tsx "test/e2e/"*.test.ts
