#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos.MX
# Move from Fly Managed Postgres ($38/mo) to an unmanaged Postgres app (~$5/mo).
#
# Safe to run only while the database holds nothing worth keeping: this does NOT
# migrate data. It provisions a new cluster, repoints the app, lets migrations
# rebuild the schema on boot, verifies, and only then destroys the old one.
#
#   FLY_API_TOKEN=... bash scripts/swap-to-unmanaged-pg.sh
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${FLY_APP:-ratchet-gate}"
NEW_PG="${APP}-pg"
REGION="${FLY_REGION:-sjc}"
OLD_MPG="${OLD_MPG_ID:-nvwq9oz445v03kl1}"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fly auth whoami >/dev/null 2>&1 || { echo "Not authenticated. Set FLY_API_TOKEN."; exit 1; }

step "Confirm the database is empty enough to rebuild"
echo "  This recreates the schema from migrations and keeps NO data."
echo "  Workspaces, API keys, effects, and ledger entries in the managed"
echo "  cluster will be gone. Only proceed if those are test records."

step "Provision unmanaged Postgres"
if fly apps list 2>/dev/null | grep -qE "^\s*${NEW_PG}\s"; then
  echo "  ${NEW_PG} already exists"
else
  fly postgres create --name "${NEW_PG}" --region "${REGION}" \
    --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
fi

step "Attach it (this replaces DATABASE_URL on ${APP})"
# `attach` refuses to overwrite an existing DATABASE_URL, so clear it first.
# --stage means the app is not restarted into a window with no database.
fly secrets unset DATABASE_URL --app "${APP}" --stage 2>&1 | tail -1 || true
# Attaching provisions a dedicated database and user rather than handing the
# app superuser credentials, which is why this is preferred over setting
# DATABASE_URL to the cluster's own connection string by hand.
fly postgres attach "${NEW_PG}" --app "${APP}" --yes 2>&1 | tail -4

step "Redeploy so both processes pick up the new DATABASE_URL"
# Migrations run on API boot inside one transaction under an advisory lock, so
# the schema is rebuilt before the health check passes.
fly deploy --app "${APP}" --ha=false

step "Verify before destroying anything"
URL="https://${APP}.fly.dev"
ok=0
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${URL}/readyz")" = "200" ]; then ok=1; break; fi
  sleep 3
done
[ "$ok" = "1" ] || { echo "  readyz never returned 200 — OLD DATABASE LEFT INTACT for rollback."; exit 1; }
echo "  readyz: $(curl -s --max-time 15 "${URL}/readyz")"

# Prove the schema really rebuilt by driving a full workflow.
W=$(curl -s --max-time 20 -X POST "${URL}/v1/workspaces" -H 'content-type: application/json' \
     -d '{"name":"Swap Verify","email":"swap@example.test"}')
K=$(printf '%s' "$W" | python3 -c 'import sys,json;print(json.load(sys.stdin)["api_key"])')
R=$(curl -s --max-time 20 -X POST "${URL}/v1/effects/begin" \
     -H "authorization: Bearer ${K}" -H 'content-type: application/json' \
     -d '{"effect_type":"email.send","idempotency_key":"swap:1","payload":{}}')
D=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["decision"])')
echo "  workflow: ${D}"
[ "$D" = "execute" ] || { echo "  core loop broken — OLD DATABASE LEFT INTACT."; exit 1; }

step "Destroy the managed cluster (stops the \$38/mo)"
fly mpg destroy "${OLD_MPG}" --yes 2>&1 | tail -3 || \
  echo "  Could not destroy automatically. Do it at: https://fly.io/dashboard → Managed Postgres"

step "Done"
echo "  ${APP} now runs on ${NEW_PG} (~\$5/mo)."
echo "  Unmanaged means YOU own backups. Fly snapshots volumes daily, but"
echo "  verify that before relying on it: fly volumes snapshots list <vol-id>"
