/**
 * Shared chrome. Rendered client-side so every page ships one copy of the
 * markup; the pages themselves stay static HTML with no build step.
 */
const LOGO = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
  <path d="M10 1.6 17.5 6v8L10 18.4 2.5 14V6L10 1.6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M6.6 10.2 9 12.6l4.6-4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const NAV = [
  ['/start', 'Get started'],
  ['/docs', 'Docs'],
  ['/works-with', 'Works with'],
  ['/blog', 'Notes'],
  ['/pricing', 'Pricing'],
  ['/security', 'Security'],
  ['/console', 'Console'],
];

export function mountChrome(current) {
  const header = document.querySelector('header.site');
  if (header) {
    header.innerHTML = `<div class="wrap">
      <a class="brand" href="/">${LOGO} Ratchet</a>
      <nav class="site" aria-label="Main">
        ${NAV.map(([href, label]) =>
          `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
      </nav>
    </div>`;
  }

  /* Drop the right-hand fade once the nav strip is scrolled to its end, so the
     hint disappears when there is nothing left to hint at. Passive listener:
     this must never delay a scroll. */
  const nav = header?.querySelector('nav.site');
  if (nav) {
    const sync = () => {
      const fits = nav.scrollWidth <= nav.clientWidth + 2;
      nav.classList.toggle('at-start', fits || nav.scrollLeft <= 2);
      nav.classList.toggle('at-end', fits || nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 2);
    };
    nav.addEventListener('scroll', sync, { passive: true });
    addEventListener('resize', sync, { passive: true });
    sync();
  }

  const footer = document.querySelector('footer.site');
  if (footer) {
    footer.innerHTML = `<div class="wrap">
      <div class="cols">
        <div>
          <h3>Product</h3>
          <ul>
            <li><a href="/docs">Documentation</a></li>
            <li><a href="/pricing">Pricing</a></li>
            <li><a href="/console">Operator console</a></li>
            <li><a href="/docs#groups">Rollback groups</a></li>
          </ul>
        </div>
        <div>
          <h3>Works with</h3>
          <ul>
            <li><a href="/works-with">Every supported platform</a></li>
            <li><a href="/start">Claude Code</a></li>
            <li><a href="/start">Claude Desktop</a></li>
            <li><a href="/start">Cursor</a></li>
            <li><a href="/start">Any MCP client</a></li>
            <li><a href="/docs">OpenAI-compatible tools</a></li>
          </ul>
        </div>
        <div>
          <h3>For agents</h3>
          <ul>
            <li><a href="/openapi.json" target="_blank" rel="noopener">OpenAPI spec<span class="fmt">JSON</span></a></li>
            <li><a href="/llms.txt" target="_blank" rel="noopener">llms.txt<span class="fmt">TXT</span></a></li>
            <li><a href="/.well-known/agent-manifest.json" target="_blank" rel="noopener">Capability manifest<span class="fmt">JSON</span></a></li>
            <li><a href="/mcp/info" target="_blank" rel="noopener">MCP server info<span class="fmt">JSON</span></a></li>
          </ul>
        </div>
        <div>
          <h3>Legal</h3>
          <ul>
            <li><a href="/terms">Terms of service</a></li>
            <li><a href="/privacy">Privacy</a></li>
            <li><a href="/.well-known/security.txt" target="_blank" rel="noopener">Report a vulnerability<span class="fmt">TXT</span></a></li>
          </ul>
        </div>
        <div>
          <h3>Operations</h3>
          <ul>
            <li><a href="/security">Security posture</a></li>
            <li><a href="/healthz" target="_blank" rel="noopener">Health<span class="fmt">JSON</span></a></li>
            <li><a href="/readyz" target="_blank" rel="noopener">Readiness<span class="fmt">JSON</span></a></li>
            <li><a href="/docs#crypto">Crypto payments</a></li>
          </ul>
        </div>
      </div>
      <div style="margin-top:2.5rem;padding-top:1.5rem;border-top:1px solid var(--border);
                  display:flex;flex-wrap:wrap;gap:1rem;align-items:baseline;justify-content:space-between">
        <p style="margin:0;max-width:52ch">
          Ratchet gates side effects. It does not execute them, holds no vendor credentials,
          and never takes custody of your funds.
        </p>
        <p style="margin:0;white-space:nowrap">
          Powered by <a href="https://deimos.mx" target="_blank" rel="noopener noreferrer">Deimos.MX</a>
        </p>
      </div>
    </div>`;
  }
}

/** Minimal, dependency-free JSON syntax highlighting for the code samples. */
export function highlight(text) {
  return text
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    .replace(/^(\s*(?:#|\/\/).*)$/gm, '<span class="c-com">$1</span>')
    .replace(/"([^"\\]*(?:\\.[^"\\]*)*)"(\s*:)/g, '<span class="c-key">"$1"</span>$2')
    .replace(/:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g, ': <span class="c-str">"$1"</span>');
}

export function tabs(container, onSelect, initial) {
  const buttons = [...container.querySelectorAll('.tab')];
  const select = (name) => {
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    onSelect(name);
  };
  for (const b of buttons) b.addEventListener('click', () => select(b.dataset.tab));
  // Choosing the opening tab HERE rather than clicking one afterwards matters:
  // each panel renders asynchronously, so a later click races the first tab's
  // in-flight render and loses to it.
  const start = buttons.find((b) => b.dataset.tab === initial) ?? buttons[0];
  select(start?.dataset.tab);
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
