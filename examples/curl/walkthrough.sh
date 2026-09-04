#!/usr/bin/env bash
# Ratchet in nine commands. Run against a local instance:
#   BASE=http://localhost:8787 bash examples/curl/walkthrough.sh
set -euo pipefail
BASE=${BASE:-http://localhost:8787}
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Every call captures its response before reading it, so a failed request shows
# you its body instead of a parser traceback you have to work backwards from.
post() { curl -s -X POST "$1" "${AUTH[@]}" -d "$2"; }
show() { printf '%s' "$1" | python3 -m json.tool; }
field() { printf '%s' "$1" | python3 -c "import sys,json;$2"; }

say "1. Create a workspace. The key is returned once."
WS=$(curl -s -X POST "$BASE/v1/workspaces" -H 'content-type: application/json' \
  -d '{"name":"Walkthrough Co","email":"walkthrough@example.test"}')
KEY=$(printf '%s' "$WS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["api_key"])')
echo "  key: ${KEY:0:20}..."
AUTH=(-H "authorization: Bearer $KEY" -H 'content-type: application/json')

say "2. Ask permission. First caller is authorised."
R=$(curl -s -X POST "$BASE/v1/effects/begin" "${AUTH[@]}" -d '{
  "effect_type":"email.send","idempotency_key":"welcome:u_1",
  "payload":{"to":"sam@example.test"},"estimated_cost_micros":800}')
echo "$R" | python3 -m json.tool
EID=$(printf '%s' "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["effect_id"])')
TOK=$(printf '%s' "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["lease_token"])')

say "3. A second caller, mid-flight, is told to stand down."
DUP=$(post "$BASE/v1/effects/begin" '{
  "effect_type":"email.send","idempotency_key":"welcome:u_1",
  "payload":{"to":"sam@example.test"}}')
field "$DUP" 'd=json.load(sys.stdin);print("  decision:",d["decision"],"| retry after",d.get("retry_after_seconds"),"s")'

say "4. Do the real work, then report the outcome."
REP=$(post "$BASE/v1/effects/$EID/report" \
  "{\"lease_token\":\"$TOK\",\"outcome\":\"succeeded\",\"result\":{\"message_id\":\"msg_77\"},\"actual_cost_micros\":780}")
show "$REP"

say "5. Every later caller replays the result instead of re-sending."
REPLAY=$(post "$BASE/v1/effects/begin" '{
  "effect_type":"email.send","idempotency_key":"welcome:u_1",
  "payload":{"to":"sam@example.test"}}')
field "$REPLAY" 'd=json.load(sys.stdin);print("  decision:",d["decision"],"| result:",d.get("result"))'

say "6. Reusing the key with different arguments is refused."
REUSE=$(post "$BASE/v1/effects/begin" '{
  "effect_type":"email.send","idempotency_key":"welcome:u_1",
  "payload":{"to":"someone-else@example.test"}}')
field "$REUSE" 'print("  error:",json.load(sys.stdin)["error"]["code"])'

say "7. Simulate a crash: take a 5s lease and never report."
CRASH=$(curl -s -X POST "$BASE/v1/effects/begin" "${AUTH[@]}" -d '{
  "effect_type":"payment.charge","idempotency_key":"invoice:2026-08:acct_1",
  "payload":{"cents":4200},"lease_seconds":5}')
printf '%s' "$CRASH" | python3 -c 'import sys,json;print("  authorised:",json.load(sys.stdin)["decision"])'
echo "  waiting for the lease to lapse..."
sleep 6

say "8. The next caller is NOT quietly allowed to retry."
BLOCKED=$(post "$BASE/v1/effects/begin" '{
  "effect_type":"payment.charge","idempotency_key":"invoice:2026-08:acct_1",
  "payload":{"cents":4200}}')
show "$BLOCKED"

say "9. Verify at the vendor, then record what really happened."
CID=$(printf '%s' "$CRASH" | python3 -c 'import sys,json;print(json.load(sys.stdin)["effect_id"])')
RESOLVED=$(post "$BASE/v1/effects/$CID/resolve" '{
  "outcome":"succeeded","evidence":"vendor dashboard shows one charge, ch_3Pab",
  "result":{"charge_id":"ch_3Pab"}}')
show "$RESOLVED"

say "The key is unblocked, and no agent can charge that customer again:"
FINAL=$(post "$BASE/v1/effects/begin" '{
  "effect_type":"payment.charge","idempotency_key":"invoice:2026-08:acct_1",
  "payload":{"cents":4200}}')
field "$FINAL" 'd=json.load(sys.stdin);print("  decision:",d["decision"],"| result:",d.get("result"))'
