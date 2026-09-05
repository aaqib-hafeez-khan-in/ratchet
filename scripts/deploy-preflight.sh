#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos LLC
# Refuses to let a deploy proceed unless the build is sound and the
# configuration is safe. Run by deploy-fly.sh; safe to run on its own.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

echo
echo "Ratchet deploy preflight"
echo

echo "Build and tests"
npx tsc -p tsconfig.json --noEmit >/dev/null 2>&1 && ok "typecheck clean" || bad "typecheck failed"
if bash scripts/test.sh >/tmp/ratchet-preflight-tests.log 2>&1; then
  n=$(grep -cE '^\s+✔' /tmp/ratchet-preflight-tests.log || echo '?')
  ok "test suite passes ($n tests)"
else
  bad "test suite failed — see /tmp/ratchet-preflight-tests.log"
fi
npm run build >/dev/null 2>&1 && ok "production build succeeds" || bad "production build failed"
if npm audit --omit=dev >/dev/null 2>&1; then ok "no production vulnerabilities"; else warn "npm audit reported findings"; fi

echo
echo "Secrets (checked in the shell, never printed)"
if [ -z "${AUTH_SECRET:-}" ]; then
  bad "AUTH_SECRET is not set — generate one with: openssl rand -base64 32"
elif [ ${#AUTH_SECRET} -lt 32 ]; then
  bad "AUTH_SECRET is shorter than 32 characters"
elif [[ "$AUTH_SECRET" == dev-only* ]]; then
  bad "AUTH_SECRET is still the development default"
else
  ok "AUTH_SECRET present and ${#AUTH_SECRET} characters"
fi
[ -n "${DATABASE_URL:-}" ] && ok "DATABASE_URL set" || warn "DATABASE_URL not set (fly postgres attach provides it)"
[ -n "${PUBLIC_URL:-}" ] && ok "PUBLIC_URL set to $PUBLIC_URL" \
  || bad "PUBLIC_URL not set — the manifest and llms.txt would advertise localhost"

echo
echo "Production safety gates"
grep -q "RATE_LIMIT_OVERRIDE is a test-only affordance" src/lib/config.ts \
  && ok "rate-limit override is refused in production" || bad "override guard missing"
[ -z "${RATE_LIMIT_OVERRIDE:-}" ] && ok "RATE_LIMIT_OVERRIDE is unset" || bad "RATE_LIMIT_OVERRIDE must be unset"
[ "${WEBHOOK_ALLOW_PRIVATE_NETWORK:-false}" = "false" ] && ok "private-network webhooks disabled" \
  || bad "WEBHOOK_ALLOW_PRIVATE_NETWORK must be false"
case "${CORS_ORIGINS:-}" in *'*'*) bad "CORS_ORIGINS must not contain '*'";; *) ok "CORS policy safe";; esac

echo
echo "Payments"
if [ "${BILLING_PROVIDER:-test}" = "stripe" ]; then
  [ -n "${STRIPE_SECRET_KEY:-}" ] && ok "Stripe key present" || bad "STRIPE_SECRET_KEY missing"
  [ -n "${STRIPE_WEBHOOK_SECRET:-}" ] && ok "Stripe webhook secret present" \
    || bad "STRIPE_WEBHOOK_SECRET missing — checkout stays closed without it"
  case "${STRIPE_SECRET_KEY:-}" in
    sk_live_*) warn "LIVE Stripe key: real charges. Refunds are handled; disputes reverse credit." ;;
    sk_test_*) ok "Stripe test key — no real money moves" ;;
  esac
else
  ok "test billing adapter (no card is charged)"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "Preflight FAILED. Nothing was deployed."
  exit 1
fi
echo "Preflight passed."
