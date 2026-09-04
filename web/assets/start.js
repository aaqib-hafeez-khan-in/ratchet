// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { mountChrome, highlight, tabs } from '/assets/partials.js';
mountChrome('/start');

const BASE = location.origin;

document.getElementById('c-key').innerHTML = highlight(
`curl -X POST ${BASE}/v1/workspaces \\
  -H "Content-Type: application/json" \\
  -d '{ "name": "My Agents", "email": "you@example.com" }'

# -> { "api_key": "rk_live_...",        <- operator: console and policy
#      "agent_api_key": "rk_live_...",  <- put THIS one in your agent
#      "workspace_id": "ws_..." }`);

/*
 * Each tab is a list of parts rather than one block. They used to be a single
 * <pre> mixing a shell command with the JSON config that replaces it — two
 * alternatives sharing a copy button, so copying either gave you both. A
 * caption above each part says where it goes; the block itself stays pasteable.
 */
const MCP_CONFIG = `{
  "mcpServers": {
    "ratchet": {
      "command": "npx",
      "args": ["-y", "ratchet-mcp"],
      "env": { "RATCHET_API_KEY": "rk_live_..." }
    }
  }
}`;

const SETUP = {
  claudecode: {
    parts: [
      { caption: 'In your project root', code:
        'claude mcp add ratchet --env RATCHET_API_KEY=rk_live_... -- npx -y ratchet-mcp' },
      { caption: 'Or write .mcp.json by hand', code: MCP_CONFIG },
    ],
    note: 'Restart Claude Code afterwards. Ask it to "check ratchet usage" to confirm the tools loaded.',
  },
  desktop: {
    parts: [
      { caption: 'macOS: ~/Library/Application Support/Claude/claude_desktop_config.json — '
               + 'Windows: %APPDATA%\\\\Claude\\\\claude_desktop_config.json',
        code: MCP_CONFIG },
    ],
    note: 'Quit and reopen Claude Desktop — it only reads this file at startup. The tools appear under the connectors icon.',
  },
  cursor: {
    parts: [
      { caption: '.cursor/mcp.json in the project, or ~/.cursor/mcp.json for all projects',
        code: MCP_CONFIG },
    ],
    note: 'Cursor can also connect over HTTP: set "url" to ' + BASE + '/mcp with an Authorization header.',
  },
  http: {
    parts: [
      { caption: 'No MCP client needed. Two POSTs.', code:
`POST ${BASE}/v1/effects/begin
Authorization: Bearer rk_live_...
{ "effect_type": "email.send", "idempotency_key": "welcome:user_123" }

POST ${BASE}/v1/effects/{effect_id}/report
Authorization: Bearer rk_live_...
{ "lease_token": "lt_...", "outcome": "succeeded", "result": {...} }` },
    ],
    note: 'Works from any language. The OpenAPI spec at /openapi.json can generate a client if you want one.',
  },
};

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

tabs(document.getElementById('setup-tabs'), (name) => {
  const { parts, note } = SETUP[name];
  document.getElementById('c-setup').innerHTML = parts.map((part) =>
    `<p class="caption">${esc(part.caption)}</p>
     <pre><code>${highlight(part.code)}</code></pre>`).join('');
  document.getElementById('setup-note').textContent = note;
});

document.getElementById('c-wrap').innerHTML = highlight(
`# Before                          # After
charge_card(customer, 4200)       gate = ratchet.begin(
                                    effect_type="payment.charge",
                                    idempotency_key=f"inv:{period}:{acct}",
                                  )
                                  if gate.decision == "duplicate":
                                      return gate.result      # already done
                                  if gate.decision != "execute":
                                      raise Blocked(gate.reason)

                                  result = charge_card(customer, 4200)

                                  ratchet.report(gate, "succeeded", result)

# That is the whole integration. Ratchet never touches your payment provider —
# it has no credentials and no outbound access. Your code still does the work.`);
