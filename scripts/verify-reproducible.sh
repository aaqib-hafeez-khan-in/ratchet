#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos AI LLC
#
# Prove the build is reproducible, rather than asserting it.
#
# Two clean builds must produce byte-identical output, and that output must
# contain nothing specific to the machine that produced it. The second half
# matters more than the first: a build is trivially identical to itself on one
# laptop, and only stops being reproducible when somebody else runs it. An
# absolute path in a source map is the usual way that happens.
#
#   bash scripts/verify-reproducible.sh
set -euo pipefail
cd "$(dirname "$0")/.."

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

manifest() {
  # Hash every file's contents AND its path, so a moved file is a difference.
  find dist -type f | LC_ALL=C sort | while read -r f; do
    printf '%s  %s\n' "$(shasum -a 256 < "$f" | cut -d' ' -f1)" "$f"
  done
}

echo "→ build 1"
rm -rf dist && npm run build >/dev/null
manifest > "$WORK/a"
FILES=$(wc -l < "$WORK/a" | tr -d ' ')

echo "→ build 2"
rm -rf dist && npm run build >/dev/null
manifest > "$WORK/b"

echo "→ comparing $FILES files"
if ! diff -u "$WORK/a" "$WORK/b" > "$WORK/diff"; then
  red "NOT REPRODUCIBLE — two clean builds differ:"
  head -20 "$WORK/diff"
  exit 1
fi
green "      identical across two clean builds"

echo "→ checking for machine-specific data in the output"
LEAKS=$(grep -rl "$PWD" dist 2>/dev/null || true)
if [ -n "$LEAKS" ]; then
  red "NOT REPRODUCIBLE — output embeds this checkout's absolute path:"
  printf '%s\n' "$LEAKS" | head -10
  exit 1
fi
green "      no absolute paths in the output"

# Source maps are the usual carrier. They must reference sources relatively.
BAD=$(find dist -name '*.js.map' -exec sh -c '
  node -e "
    const m = require(process.argv[1]);
    const abs = (m.sources || []).filter(s => s.startsWith(\"/\") || /^[A-Za-z]:\\\\/.test(s));
    if (abs.length || (m.sourceRoot || \"\").startsWith(\"/\")) console.log(process.argv[1]);
  " "$1"' _ {} \; 2>/dev/null || true)
if [ -n "$BAD" ]; then
  red "NOT REPRODUCIBLE — source maps reference absolute sources:"
  printf '%s\n' "$BAD" | head -10
  exit 1
fi
green "      source maps reference sources relatively"

echo
green "Reproducible: $FILES files, identical, machine-independent."
