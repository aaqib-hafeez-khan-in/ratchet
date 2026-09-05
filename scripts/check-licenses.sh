#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos LLC
#
# Enforce the licence policy in docs/OPEN_SOURCE_POLICY.md §3 against what is
# actually in the production dependency tree.
#
# The policy exists to be applied, not read. Writing "we accept permissive
# licences" and never checking is how a copyleft dependency arrives in a
# distributed artifact without anybody deciding to allow it. The first run of
# this check found five BlueOak-1.0.0 packages the policy had not listed.
#
# Development dependencies are out of scope on purpose: they are not
# distributed, so their licences impose no obligation on what we ship.
set -euo pipefail
cd "$(dirname "$0")/.."

# OSI-approved permissive licences with no reciprocal obligation on
# distribution. Adding one here is a policy decision, so it happens in a commit
# somebody signs rather than silently at install time.
ALLOWED='MIT|ISC|Apache-2.0|BSD-2-Clause|BSD-3-Clause|0BSD|BlueOak-1.0.0|CC0-1.0|Unlicense|Python-2.0'

out=$(npx --yes license-checker-rseidelsohn --production --json 2>/dev/null)

printf '%s' "$out" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const pkgs = JSON.parse(s);
    const allowed = new RegExp("^(" + process.argv[1] + ")$");
    const bad = [];
    for (const [name, info] of Object.entries(pkgs)) {
      // The root package is private:true, which license-checker reports as
      // UNLICENSED whatever its license field says. It is never published.
      if (info.private === true || info.private === "true") continue;
      const raw = String(info.licenses ?? "UNKNOWN");
      // "(MIT OR Apache-2.0)" and "MIT AND ISC" both satisfy the policy when
      // every named licence does.
      const parts = raw.replace(/[()]/g, "").split(/\s+(?:OR|AND)\s+/);
      if (!parts.every(p => allowed.test(p.trim().replace(/\*$/, "")))) {
        bad.push(`${name}  ${raw}`);
      }
    }
    if (bad.length) {
      console.error("licences outside the policy:");
      for (const b of bad) console.error("  " + b);
      console.error("");
      console.error("Either the dependency goes, or docs/OPEN_SOURCE_POLICY.md §3");
      console.error("and the allowlist in scripts/check-licenses.sh change together.");
      process.exit(1);
    }
    console.log(`licences: ${Object.keys(pkgs).length} production packages, all within policy`);
  });
' "$ALLOWED"
