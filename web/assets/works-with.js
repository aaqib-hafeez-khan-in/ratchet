import { reveal } from '/assets/reveal.js';

/**
 * The compatibility router.
 *
 * This page names platforms, and shows no logos. The rule it follows, stated
 * on the page itself: name a platform only where the reader can act on the
 * name — where there is a real integration path they can follow today. Never
 * name a company purely to borrow its credibility. Nobody listed here is a
 * customer, and nothing here is an endorsement.
 */

// path: how you actually connect. That is the only sort order that helps.
// Derived, not hardcoded. This file shipped a stale ratchet-gate.fly.dev URL
// through the domain cutover because the snippet is rendered client-side and
// never appears in the page HTML, so nothing that greps the served pages could
// see it. docs.js and start.js already do this.
const BASE = location.origin;

const PLATFORMS = [
  // ── Speaks MCP ────────────────────────────────────────────────────────
  ['Claude Code',        'mcp',  'stdio'],
  ['Claude Desktop',     'mcp',  'stdio'],
  ['Cursor',             'mcp',  'stdio'],
  ['Windsurf',           'mcp',  ''],
  ['Zed',                'mcp',  ''],
  ['Cline',              'mcp',  ''],
  ['Continue',           'mcp',  ''],
  ['Goose',              'mcp',  ''],
  ['VS Code agent mode', 'mcp',  ''],
  ['JetBrains AI',       'mcp',  ''],

  // ── Calls HTTP ────────────────────────────────────────────────────────
  ['LangChain',            'http', 'as a custom tool'],
  ['LangGraph',            'http', 'as a node'],
  ['LlamaIndex',           'http', 'as a tool'],
  ['CrewAI',               'http', 'as a tool'],
  ['AutoGen',              'http', 'as a function'],
  ['Pydantic AI',          'http', 'as a tool'],
  ['Vercel AI SDK',        'http', 'as a tool'],
  ['Mastra',               'http', 'as a tool'],
  ['OpenAI Agents SDK',    'http', 'function calling'],
  ['Gemini function calling', 'http', ''],
  ['n8n',                  'http', 'HTTP Request node'],
  ['Zapier',               'http', 'Webhooks action'],
  ['Make',                 'http', 'HTTP module'],
  ['Retool',               'http', 'REST resource'],
  ['Microsoft Copilot Studio', 'http', 'custom connector from our OpenAPI'],
  ['Salesforce Agentforce','http', 'External Services / Apex callout'],
  ['ServiceNow',           'http', 'IntegrationHub REST step'],
  ['Devin',                'http', 'it writes the call itself'],
  ['Manus',                'http', 'it writes the call itself'],
  ['Genspark',             'http', 'it writes the call itself'],
  ['Replit Agent',         'http', 'it writes the call itself'],
  ['Codex',                'http', 'it writes the call itself'],
  ['Lovable',              'http', 'in the app it generates'],

  // ── Your own model ────────────────────────────────────────────────────
  ['Ollama',        'model', 'worked example'],
  ['vLLM',          'model', ''],
  ['llama.cpp',     'model', ''],
  ['LM Studio',     'model', ''],
  ['Together AI',   'model', ''],
  ['Fireworks AI',  'model', ''],
  ['Baseten',       'model', ''],
  ['fal',           'model', ''],
  ['SambaNova',     'model', ''],
  ['Groq',          'model', ''],
  ['Cohere',        'model', ''],
  ['Mistral AI',    'model', ''],
  ['Databricks',    'model', ''],
  ['Amazon Bedrock','model', ''],
  ['Google Vertex AI', 'model', ''],
  ['A custom DNN or fine-tune', 'model', ''],
];

const VERIFIED = {
  mcp: 'The published <code>ratchet-mcp</code> package is installed fresh from npm and driven '
     + 'through a full handshake, <code>tools/list</code>, and a real gated effect against '
     + 'production. That exercises the stdio transport every client here uses — not each '
     + 'client app individually.',
  http: 'The exact code shown below is executed by the test suite on every run: begin, report, '
      + 'the duplicate replay, and the retry-after-failure branch. A recipe that stops working '
      + 'fails the build.',
  model: 'A real local 8B model was run end to end: it issued a refund, the gateway timed out, '
       + 'the outcome was never confirmed, and the retry was correctly refused as '
       + '<code>indeterminate</code> rather than waved through.',
};

const PATHS = {
  mcp: {
    title: 'Speaks MCP',
    blurb: 'One block of config. The gate arrives as tools the model can call, and the client handles the rest.',
    snippet: `{
  "mcpServers": {
    "ratchet": {
      "command": "npx",
      "args": ["-y", "ratchet-mcp"],
      "env": { "RATCHET_API_KEY": "rk_live_…" }
    }
  }
}`,
    lang: 'json',
  },
  http: {
    title: 'Calls HTTP',
    blurb: 'One POST before the action, one after. No SDK required, no library to keep current — if it can reach an HTTPS endpoint, it can use the gate.',
    snippet: `POST ${BASE}/v1/effects/begin
Authorization: Bearer rk_live_…

{
  "effect_type": "email.send",
  "idempotency_key": "invoice:2026-08:acct_8812",
  "payload": { "to": "customer@example.com" }
}

→ { "decision": "execute", "lease_token": "…" }
   Only "execute" authorises you to act.`,
    lang: 'http',
  },
  model: {
    title: 'Runs your own model',
    blurb: 'The gate sits in your application, not in the model. That is why it works the same whether the weights are frontier, open, local, or something you trained yourself.',
    snippet: `# The model proposes. Your code asks the gate. The gate decides.
args = tool_call.arguments
d = requests.post(f"{RATCHET}/v1/effects/begin",
    headers={"Authorization": f"Bearer {KEY}"},
    json={
      "effect_type": "payment.refund",
      # Derived from the work itself — never random, never a timestamp.
      "idempotency_key": f"refund:{args['order_id']}:{args['amount']}",
      "payload": args,
    }).json()

if d["decision"] == "execute":
    do_the_refund(args)          # and only then`,
    lang: 'python',
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderGroups(filter = '') {
  const q = filter.trim().toLowerCase();
  const host = document.getElementById('groups');
  const empty = document.getElementById('noMatch');
  let shown = 0;

  host.innerHTML = Object.entries(PATHS).map(([key, p]) => {
    const items = PLATFORMS.filter(([n, path]) =>
      path === key && (!q || n.toLowerCase().includes(q)));
    if (!items.length) return '';
    shown += items.length;
    return `<section class="path" data-path="${key}" data-reveal>
      <div class="wrap">
      <div class="path-head">
        <h2>${esc(p.title)}</h2>
        <p class="dim">${esc(p.blurb)}</p>
        ${VERIFIED[key] ? `<p class="verified-note"><span class="tag ok">verified</span>
          ${VERIFIED[key]}</p>` : ''}
      </div>
      <ul class="names">
        ${items.map(([n, , note]) => `<li data-reveal>
          <span class="n">${esc(n)}</span>
          ${note === 'verified' || note.startsWith('verified')
            ? `<span class="tag ok" title="We ran it ourselves.">verified</span>`
            : note ? `<span class="tag">${esc(note)}</span>` : ''}
        </li>`).join('')}
      </ul>
      <pre class="snippet"><code>${esc(p.snippet)}</code></pre>
      </div>
    </section>`;
  }).join('');

  empty.hidden = shown > 0;
  if (!shown) {
    empty.innerHTML = `<p><strong>“${esc(filter)}” isn’t on the list — which doesn’t mean it won’t work.</strong></p>
      <p class="dim">The list names things we can point you at, not the limit of what connects.
      The real requirement is one HTTPS POST before the action and one after.
      If your tool can do that in any language, it can use the gate.</p>
      <pre class="snippet"><code>${esc(PATHS.http.snippet)}</code></pre>`;
  }
  observe();
}

/* Reveal uses the shared module now. This page had its own copy, which is one
   copy too many: the fail-safe behaviour it grew — never depend on an observer
   firing, never leave the page blank — belongs everywhere, not just here. */
function observe() {
  reveal({ stagger: 22 });
}

const input = document.getElementById('q');
input?.addEventListener('input', () => renderGroups(input.value));
renderGroups();
