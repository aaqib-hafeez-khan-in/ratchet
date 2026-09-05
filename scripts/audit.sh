#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos AI LLC
#
# Production dependency audit, with the registry's own unreliability accounted for.
#
# `npm audit` answers two very different questions with the same exit code: "I
# checked and found vulnerabilities" and "I could not check". The second one
# started happening on its own — npm's quick-audit endpoint returns 400 with the
# notice "This endpoint is being retired", and a build failed on it having found
# nothing wrong at all.
#
# Collapsing those two into one red X is bad in both directions. Treating a
# registry outage as a finding blocks a release for no reason. Treating it as a
# pass claims a clean audit that never ran — the same mistake this whole codebase
# refuses to make about an effect whose outcome is unknown.
#
# So: retry, because most registry errors are transient; then report what
# actually happened, in the caller's own words.
set -uo pipefail
cd "$(dirname "$0")/.."

ATTEMPTS=${AUDIT_ATTEMPTS:-3}
out=""

for i in $(seq 1 "$ATTEMPTS"); do
  out=$(npm audit --omit=dev --json 2>&1)
  code=$?

  # A real answer carries the counts, whether or not anything was found.
  if printf '%s' "$out" | grep -q '"vulnerabilities"'; then
    total=$(printf '%s' "$out" | node -e '
      let s = "";
      process.stdin.on("data", d => s += d).on("end", () => {
        try {
          const j = JSON.parse(s.slice(s.indexOf("{")));
          const v = j.metadata?.vulnerabilities ?? {};
          const n = ["critical","high","moderate","low"].reduce((a,k)=>a+(v[k]||0),0);
          console.log(`${n} ${v.critical||0} ${v.high||0} ${v.moderate||0} ${v.low||0}`);
        } catch { console.log("parse-failed"); }
      });')

    if [ "$total" = "parse-failed" ]; then
      echo "audit: could not parse the registry's reply" >&2
      exit 2
    fi

    set -- $total
    if [ "$1" -eq 0 ]; then
      echo "audit: 0 production vulnerabilities"
      exit 0
    fi
    echo "audit: $1 production vulnerabilities — critical $2, high $3, moderate $4, low $5" >&2
    npm audit --omit=dev >&2 || true
    exit 1
  fi

  echo "audit: attempt $i/$ATTEMPTS did not get an answer from the registry" >&2
  printf '%s\n' "$out" | tail -4 >&2
  [ "$i" -lt "$ATTEMPTS" ] && sleep $((i * 10))
done

# Never green on an unanswered question. An unknown outcome stays unknown here
# too — but say which kind of failure it is, so nobody goes looking for a CVE
# that was never reported.
echo >&2
echo "audit: the registry did not answer after $ATTEMPTS attempts." >&2
echo "       This is an npm availability failure, NOT a reported vulnerability." >&2
exit 2
