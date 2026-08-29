#!/usr/bin/env bash
# One-command deploy to Fly.io.
#
#   brew install flyctl && fly auth login     # once, needs your browser
#   bash scripts/deploy-fly.sh
#
# Idempotent: safe to re-run. Creates what is missing, skips what exists.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${FLY_APP:-ratchet}"
REGION="${FLY_REGION:-iad}"
DB="${APP}-db"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

have fly || { echo "flyctl not installed:  brew install flyctl"; exit 1; }
fly auth whoami >/dev/null 2>&1 || { echo "Not logged in:  fly auth login"; exit 1; }
echo "Deploying as $(fly auth whoami)"

step "Preflight"
# PUBLIC_URL is known only once the app name is fixed, so supply it here.
PUBLIC_URL="https://${APP}.fly.dev" AUTH_SECRET="${AUTH_SECRET:-$(openssl rand -base64 32)}" \
  bash scripts/deploy-preflight.sh

step "Application"
if fly apps list 2>/dev/null | grep -qE "^${APP}\s"; then
  echo "  ${APP} exists"
else
  fly apps create "${APP}" --org "${FLY_ORG:-personal}"
fi

step "Database"
if fly postgres list 2>/dev/null | grep -qE "^${DB}\s"; then
  echo "  ${DB} exists"
else
  # Smallest managed Postgres. Resize with: fly machine update -a ${DB}
  fly postgres create --name "${DB}" --region "${REGION}" \
    --initial-cluster-size 1 --vm-size shared-cpu-1x --volume-size 10
fi
# Attaching sets DATABASE_URL as a secret on the app. Harmless if already done.
fly postgres attach "${DB}" --app "${APP}" 2>/dev/null || echo "  already attached"

step "Secrets"
# AUTH_SECRET is generated once and never regenerated: rotating it invalidates
# every API key and console session in existence.
if fly secrets list --app "${APP}" 2>/dev/null | grep -q AUTH_SECRET; then
  echo "  AUTH_SECRET already set — left alone (rotating it invalidates all API keys)"
else
  fly secrets set --app "${APP}" --stage "AUTH_SECRET=$(openssl rand -base64 32)"
  echo "  AUTH_SECRET generated"
fi
fly secrets set --app "${APP}" --stage "PUBLIC_URL=https://${APP}.fly.dev"

# Payments are opt-in. Without these the built-in test adapter runs and no card
# is ever charged.
for v in BILLING_PROVIDER STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_AUTOMATIC_TAX; do
  if [ -n "${!v:-}" ]; then
    fly secrets set --app "${APP}" --stage "${v}=${!v}"
    echo "  ${v} staged"
  fi
done

step "Deploy"
# Both process groups ship from one image; the API migrates on boot behind an
# advisory lock, so a concurrent worker start is safe.
fly deploy --app "${APP}" --ha=false

step "Verify"
URL="https://${APP}.fly.dev"
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${URL}/readyz" || true)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "  readyz    $(curl -s "${URL}/readyz")"
echo "  manifest  $(curl -s -o /dev/null -w '%{http_code}' "${URL}/.well-known/agent-manifest.json")"
echo "  mcp       $(curl -s -o /dev/null -w '%{http_code}' -X POST "${URL}/mcp")  (401 expected: it requires a key)"
echo "  worker    $(fly logs --app "${APP}" --no-tail 2>/dev/null | grep -c 'worker started' || echo 0) start line(s) in logs"

cat <<EOF

Deployed: ${URL}

Next:
  1. Confirm the manifest advertises real URLs, not localhost:
       curl ${URL}/.well-known/agent-manifest.json | grep url
  2. For live payments, create a Stripe webhook endpoint at
       ${URL}/v1/billing/webhook/stripe
     for checkout.session.completed, charge.refunded, charge.dispute.created,
     then set its signing secret (different from your local CLI one):
       fly secrets set --app ${APP} STRIPE_WEBHOOK_SECRET=whsec_...
  3. Watch the numbers that decide pricing:
       fly ssh console --app ${APP} -C "node dist/../scripts/metrics.ts" || npm run metrics
EOF
