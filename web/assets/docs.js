import { mountChrome, highlight, tabs, esc } from '/assets/partials.js';
mountChrome('/docs');

const BASE = location.origin;

const S = {
  signup: `curl -X POST ${BASE}/v1/workspaces \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "Acme Agents", "email": "ops@acme.example" }'

# -> { "workspace_id": "ws_...", "api_key": "rk_test_...", "plan": "free" }
#    The key is returned once. Store it now; it cannot be retrieved again.`,

  begin: `curl -X POST ${BASE}/v1/effects/begin \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "effect_type": "email.send",
    "idempotency_key": "welcome:user_123",
    "payload": { "to": "sam@example.com", "template": "welcome" },
    "estimated_cost_micros": 800,
    "agent_id": "onboarding-agent",
    "run_id": "run_2026_08_29_a"
  }'

# -> {
#      "decision": "execute",
#      "effect_id": "eff_08kdjqj4y23c8x9h",
#      "lease_token": "lt_twx612hyw0x66x5b",
#      "lease_expires_at": "2026-08-29T06:46:22.778Z",
#      "attempt": 1,
#      "billing": { "metered": true, "included_remaining": 4999 }
#    }`,

  report: `curl -X POST ${BASE}/v1/effects/eff_08kdjqj4y23c8x9h/report \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "lease_token": "lt_twx612hyw0x66x5b",
    "outcome": "succeeded",
    "result": { "message_id": "msg_9f2" },
    "actual_cost_micros": 750
  }'

# Every later caller with the same key now receives:
# -> { "decision": "duplicate", "result": { "message_id": "msg_9f2" } }`,

  policy: `curl -X PUT ${BASE}/v1/policies/payment.charge \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "mode": "allow",
    "on_indeterminate": "probe",
    "lease_seconds": 90,
    "max_attempts": 3,
    "max_cost_micros": 50000,
    "daily_budget_micros": 2000000,
    "retention_days": 7
  }'`,

  circuit: `# Stop this effect type if it suddenly runs far more than usual.
# 200/hour is normal here; 400 means something is looping.
curl -X PUT ${BASE}/v1/policies/email.send \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "mode": "allow",
    "surge_per_hour": 400,
    "surge_action": "require_approval",
    "surge_cooldown_seconds": 3600
  }'

# What volume am I actually running? Set a threshold from this.
curl ${BASE}/v1/circuits -H "Authorization: Bearer $RATCHET_API_KEY"

# -> { "circuits": [],
#      "rates": [ { "effect_type": "email.send",
#                   "this_hour": 187, "peak_hour": 213 } ] }`,

  'circuit-stop': `# Halt every effect type in the workspace, now.
curl -X POST ${BASE}/v1/circuits/*/open \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "action": "deny", "reason": "agent looping on support inbox" }'

# Every begin now returns:
# -> { "decision": "denied",
#      "reason": "Circuit breaker open for *: agent looping on support inbox" }

# Back to normal once you have looked at it. This gives the effect type a
# fresh allowance; it does not disarm the breaker.
curl -X POST ${BASE}/v1/circuits/*/close \\
  -H "Authorization: Bearer $RATCHET_API_KEY"`,

  resolve: `# You checked Stripe. The charge did land.
curl -X POST ${BASE}/v1/effects/eff_a3emswr6v37zey5p/resolve \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "outcome": "succeeded",
    "evidence": "stripe dashboard shows charge ch_3Pab; no second charge present",
    "result": { "charge_id": "ch_3Pab" }
  }'

# The key is unblocked. The next begin() returns "duplicate" with that result,
# so no agent can charge the customer again.`,

  stdio: `// claude_desktop_config.json, .cursor/mcp.json, or Claude Code's MCP config
{
  "mcpServers": {
    "ratchet": {
      "command": "node",
      "args": ["/absolute/path/to/ratchet/dist/mcp/stdio.js"],
      "env": {
        "RATCHET_API_KEY": "rk_live_...",
        "DATABASE_URL": "postgres://user:pass@host/ratchet"
      }
    }
  }
}

// The key lives in "env", never in "args", so it stays out of process listings.`,

  http: `POST ${BASE}/mcp
Authorization: Bearer rk_live_...
Content-Type: application/json

{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }

# Stateless: every request is authorised on its own, so the endpoint scales
# horizontally and no session state is shared between tenants.
# Protocol versions supported: 2025-06-18, 2025-03-26, 2024-11-05`,
};

S.group = `# Each step declares how to undo itself, while you still know.
curl -X POST ${BASE}/v1/effects/begin \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "effect_type": "flight.book",
    "idempotency_key": "trip:8812:flight",
    "group_key": "trip:8812",
    "payload": { "passenger": "sam", "leg": "LHR-JFK" },
    "compensation": {
      "effect_type": "flight.cancel",
      "payload": { "ref": "FL123" }
    }
  }'`;

S.unwind = `# Payment failed. Ask what has to be undone.
curl -X POST ${BASE}/v1/groups/trip:8812/unwind \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -d '{ "reason": "card declined" }'

# -> {
#      "state": "unwinding",
#      "steps": [
#        { "order": 1,
#          "original_effect_type": "hotel.book",
#          "compensation": { "effect_type": "hotel.cancel", ... },
#          "suggested_idempotency_key": "compensate:eff_9f2..." },
#        { "order": 2, "original_effect_type": "flight.book", ... }
#      ],
#      "irreversible": [ { "effect_type": "email.send" } ],
#      "unresolved": []
#    }

# Gate each undo, so the rollback is at-most-once too.
curl -X POST ${BASE}/v1/effects/begin \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -d '{
    "effect_type": "hotel.cancel",
    "idempotency_key": "compensate:eff_9f2...",
    "compensates_effect_id": "eff_9f2...",
    "payload": { "ref": "HT456" }
  }'`;

S.crypto = `# What this instance accepts, and on what terms.
curl ${BASE}/v1/billing/crypto/assets

# Quote a top-up. Priced in USD; you send the token amount shown.
curl -X POST ${BASE}/v1/billing/crypto/intents \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -d '{ "token_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "usd_micros": 25000000 }'

# -> { "symbol": "USDC", "amount": "25.000000",
#      "destination": "<an address the operator controls>",
#      "memo": "ratchet-8f2ka9",
#      "expires_at": "...",
#      "instructions": [ "Send exactly 25.000000 USDC to ...",
#                        "Include the memo — it attributes the payment.",
#                        "A transfer short of the quote is not credited." ] }`;

for (const [id, key] of [['c-signup','signup'], ['c-begin','begin'], ['c-report','report'],
                         ['c-policy','policy'], ['c-resolve','resolve'],
                         ['c-group','group'], ['c-unwind','unwind'], ['c-crypto','crypto'],
                           ['c-circuit','circuit'], ['c-circuit-stop','circuit-stop']]) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = highlight(S[key]);
}

tabs(document.getElementById('mcp-tabs'), (name) => {
  document.getElementById('c-mcp').innerHTML = highlight(S[name]);
});

try {
  const info = await (await fetch('/mcp/info')).json();
  document.getElementById('mcp-tools').innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th>Tool</th><th>Scope</th><th>What it does</th></tr></thead><tbody>
    ${info.tools.map((t) => `<tr>
      <td class="mono">${esc(t.name)}</td>
      <td class="mono small faint">${esc(t.required_scope)}</td>
      <td class="small">${esc(t.description.split('\n')[0])}</td>
    </tr>`).join('')}
    </tbody></table></div>`;
} catch {
  document.getElementById('mcp-tools').innerHTML =
    '<p class="notice bad">Could not load the tool list.</p>';
}

import { revealSections } from '/assets/reveal.js';
revealSections({});
