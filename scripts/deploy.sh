#!/usr/bin/env bash
#
# Deploy to production, but only a build that has already survived staging.
#
# Written the day five failing tests reached production because the deploy was
# chained into the same command as the test run. CI catches a broken change and
# staging catches a broken deploy, but neither helps if nothing makes you go
# through them. This does.
#
# Four gates, in the order that a failure is cheapest to discover:
#
#   1. The working tree is clean and pushed. Whatever is live must be something
#      another person — or you, in six months — can check out and reproduce.
#   2. CI is green for this commit.
#   3. Staging is running THIS commit. Not a similar one, not yesterday's.
#   4. The staging smoke test passes right now, against that build.
#
# There is an escape hatch, because refusing to deploy during an incident would
# be its own outage: `npm run deploy:force`. It is deliberately a different
# command rather than a flag, so it cannot be reached by habit or by a stray
# keystroke, and it announces itself in the output.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_PROD="ratchet-gate"
APP_STAGING="ratchet-gate-staging"
STAGING_URL="https://${APP_STAGING}.fly.dev"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

refuse() {
  echo
  red "REFUSING TO DEPLOY: $1"
  [ $# -gt 1 ] && echo "  $2"
  echo
  echo "  If this is an incident and you accept the risk:  npm run deploy:force"
  exit 1
}

HEAD_SHA=$(git rev-parse HEAD)
SHORT=$(git rev-parse --short HEAD)

# ── 1. reproducible ─────────────────────────────────────────────────────────
step "1/4  Is this build reproducible?"
if [ -n "$(git status --porcelain)" ]; then
  refuse "the working tree has uncommitted changes" \
    "Whatever is live must be something you can check out again. Commit or stash."
fi
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if ! git merge-base --is-ancestor "$HEAD_SHA" "origin/$BRANCH" 2>/dev/null; then
  refuse "this commit is not pushed to origin/$BRANCH" \
    "Push first, so what is live exists somewhere other than this laptop."
fi
green "      clean tree, $SHORT pushed to origin/$BRANCH"

# ── 2. CI ───────────────────────────────────────────────────────────────────
step "2/4  Is CI green for $SHORT?"
CI_STATUS=$(gh run list --workflow=ci.yml --commit "$HEAD_SHA" --limit 1 \
  --json conclusion --jq '.[0].conclusion // "none"' 2>/dev/null || echo "unknown")
case "$CI_STATUS" in
  success) green "      CI passed" ;;
  none)    refuse "CI has not run for $SHORT" "Wait for it, or push again." ;;
  unknown) refuse "could not reach GitHub to check CI" "Check your gh auth." ;;
  *)       refuse "CI concluded '$CI_STATUS' for $SHORT" ;;
esac

# ── 3. staging is this build ────────────────────────────────────────────────
step "3/4  Is staging running $SHORT?"
# Staging scales to zero, so it is usually suspended. Wake it before asking:
# otherwise a sleeping machine looks exactly like a staging app that was never
# deployed, and the refusal would send you to fix the wrong thing.
curl -s -o /dev/null --max-time 30 "$STAGING_URL/healthz" || true
STAGING_SHA=$(flyctl ssh console -a "$APP_STAGING" -C "printenv GIT_COMMIT" 2>/dev/null \
  | tr -d '\r' | grep -E '^[0-9a-f]{40}$' | head -1 || true)

if [ -z "$STAGING_SHA" ]; then
  refuse "could not read the commit staging is running" \
    "Deploy it first:  npm run deploy:staging"
fi
if [ "$STAGING_SHA" != "$HEAD_SHA" ]; then
  refuse "staging is running a different commit" \
    "staging ${STAGING_SHA:0:7}, you are deploying $SHORT. Run: npm run deploy:staging"
fi
green "      staging is on $SHORT"

# ── 4. it actually works there ──────────────────────────────────────────────
step "4/4  Does that build pass its smoke test?"
if ! BASE="$STAGING_URL" node scripts/smoke.mjs; then
  refuse "the staging smoke test failed" \
    "That is the same build you were about to put in front of customers."
fi

# ── go ──────────────────────────────────────────────────────────────────────
step "Deploying $SHORT to production"
flyctl deploy --now --build-arg "GIT_COMMIT=$HEAD_SHA"

step "Verifying production"
for path in /healthz /readyz /workerz; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "https://ratchetgate.com$path")
  if [ "$code" = "200" ]; then
    green "      $path  $code"
  else
    red   "      $path  $code"
    echo
    red "Production is answering badly after the deploy. Roll back:"
    echo "  flyctl releases --app $APP_PROD"
    echo "  flyctl deploy --image <previous-image-ref>"
    exit 1
  fi
done

echo
green "Deployed $SHORT."
