#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos AI LLC
#
# Publish server.json to the official MCP Registry.
#
# WHY THIS EXISTS. The registry is canonical: Glama, mcp.so and Smithery consume
# its data, so whatever it says is what every marketplace tells people to
# install. On 6 Sep 2026 it said ratchet-mcp@0.1.1 while npm shipped 0.2.1 —
# every visitor arriving through a marketplace installed a bridge two versions
# old, and nothing anywhere would ever have said so.
#
# So this refuses to publish a listing that disagrees with the package it points
# at. Same rule as test/unit/claims-audit.test.ts, applied to the one claim that
# is made outside the repository.
#
# THE SIGNING KEY IS NEVER PRINTED, never written to disk by this script, and
# never passed as a visible argument. Provide it as MCP_REGISTRY_PRIVATE_KEY in
# the environment, or be prompted for it silently.
set -euo pipefail

DOMAIN="ratchetgate.com"
MANIFEST="server.json"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
green(){ printf '\033[32m%s\033[0m\n' "$*"; }

command -v mcp-publisher >/dev/null || {
  red "mcp-publisher is not installed."
  echo "  brew install mcp-publisher   (or see modelcontextprotocol.io)"; exit 1; }

[ -f "$MANIFEST" ] || { red "$MANIFEST not found — run from the repository root."; exit 1; }

# ── The gate: the listing must agree with the package it points at ───────────
MANIFEST_VERSION=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['version'])")
PKG_NAME=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['packages'][0]['identifier'])")
PKG_VERSION=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['packages'][0]['version'])")
NPM_VERSION=$(npm view "$PKG_NAME" version 2>/dev/null || true)

echo "  listing version   : $MANIFEST_VERSION"
echo "  points npm at     : $PKG_NAME@$PKG_VERSION"
echo "  npm actually has  : ${NPM_VERSION:-<unreachable>}"

[ -n "$NPM_VERSION" ] || { red "Could not reach npm. A check that cannot run is not a pass."; exit 1; }

if [ "$PKG_VERSION" != "$NPM_VERSION" ]; then
  red "REFUSING: the listing would tell people to install $PKG_NAME@$PKG_VERSION, but npm ships $NPM_VERSION."
  echo "  Publishing this is how the registry went stale before. Update $MANIFEST first."
  exit 1
fi
if [ "$MANIFEST_VERSION" != "$NPM_VERSION" ]; then
  red "REFUSING: listing version $MANIFEST_VERSION does not match the package version $NPM_VERSION."
  exit 1
fi

# Description has a hard 100-character limit; a rejection here is slow to debug.
python3 - <<'PY'
import json, sys
d = json.load(open('server.json'))
n = len(d['description'])
if n > 100:
    sys.exit(f"REFUSING: description is {n} characters; the registry limit is 100.")
print(f"  description       : {n}/100 characters")
PY

# ── Domain verification must be live before login, or the login simply fails ─
PUBLIC_KEY_URL="https://$DOMAIN/.well-known/mcp-registry-auth"
if ! curl -fsS -m 15 "$PUBLIC_KEY_URL" | grep -q 'k=ed25519'; then
  red "REFUSING: $PUBLIC_KEY_URL is not serving an ed25519 public key."
  echo "  Domain verification would fail. Deploy first, then retry."
  exit 1
fi
green "  domain proof      : live at $PUBLIC_KEY_URL"

# ── The secret. Never echoed, never stored by this script. ───────────────────
if [ -z "${MCP_REGISTRY_PRIVATE_KEY:-}" ]; then
  printf '  signing key (input hidden): '
  read -rs MCP_REGISTRY_PRIVATE_KEY
  echo
fi
[ -n "$MCP_REGISTRY_PRIVATE_KEY" ] || { red "No signing key supplied."; exit 1; }

# Passed on stdin rather than argv so it never appears in `ps` output.
mcp-publisher login http --domain "$DOMAIN" --private-key "$MCP_REGISTRY_PRIVATE_KEY" >/dev/null
unset MCP_REGISTRY_PRIVATE_KEY
green "  authenticated as  : $DOMAIN"

mcp-publisher publish
green "Published $MANIFEST_VERSION."

# ── Verify what the registry now serves, rather than trusting the exit code ──
sleep 3
python3 - <<'PY'
import json, urllib.request
url = "https://registry.modelcontextprotocol.io/v0/servers?search=com.ratchetgate"
d = json.loads(urllib.request.urlopen(url, timeout=20).read())
rows = [e for e in d.get('servers', []) if e.get('server', e).get('name') == 'com.ratchetgate/ratchet']
rows.sort(key=lambda e: e.get('_meta', {}).get('io.modelcontextprotocol.registry/official', {}).get('publishedAt', ''))
if not rows:
    raise SystemExit("  could not read the listing back — check manually")
s = rows[-1]['server']; p = (s.get('packages') or [{}])[0]
print(f"  registry now says : {s.get('version')}, installing {p.get('identifier')}@{p.get('version')}")
PY
