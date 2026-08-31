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
const PLATFORMS = [
  // ── Speaks MCP ────────────────────────────────────────────────────────
  ['Claude Code',        'mcp',  'verified'],
  ['Claude Desktop',     'mcp',  'verified'],
  ['Cursor',             'mcp',  'verified'],
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
  ['Ollama',        'model', 'verified — see the worked example'],
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
    snippet: `POST https://ratchet-gate.fly.dev/v1/effects/begin
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
    return `<section class="path" data-path="${key}">
      <div class="wrap">
      <div class="path-head">
        <h2>${esc(p.title)}</h2>
        <p class="dim">${esc(p.blurb)}</p>
      </div>
      <ul class="names">
        ${items.map(([n, , note]) => `<li>
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

/* Reveal on scroll.
   The content is the point; the motion is not. An IntersectionObserver that
   never fires — a hidden tab, a prerender, a browser that throttles it — must
   not be able to leave the page blank, so nothing here depends on one firing.
   A plain sweep decides what is visible, several things call it, and the whole
   mechanism removes itself once everything is shown. */
const MOTION_OK = !matchMedia('(prefers-reduced-motion: reduce)').matches;

function revealAll() {
  document.querySelectorAll('.path, .names li').forEach((el) => el.classList.add('in'));
}

let queued = false;
function sweep() {
  queued = false;
  const pending = document.querySelectorAll('.path:not(.in), .names li:not(.in)');
  if (!pending.length) { teardown(); return; }
  const limit = innerHeight * 0.94;
  pending.forEach((el) => {
    if (el.getBoundingClientRect().top < limit) el.classList.add('in');
  });
}

const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(sweep); } };

function teardown() {
  removeEventListener('scroll', onScroll);
  removeEventListener('resize', onScroll);
}

function observe() {
  if (!MOTION_OK) { revealAll(); return; }
  document.documentElement.classList.add('js-motion');

  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  // Whatever is on screen at mount arrives with the page, not after it.
  requestAnimationFrame(sweep);
  // And a hard backstop: if anything above has been prevented from running,
  // the page still ends up readable rather than empty.
  setTimeout(sweep, 400);
  setTimeout(revealAll, 2500);
  document.addEventListener('visibilitychange', sweep);
}

const input = document.getElementById('q');
input?.addEventListener('input', () => renderGroups(input.value));
renderGroups();
