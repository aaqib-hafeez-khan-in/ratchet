/**
 * Shared chrome. Rendered client-side so every page ships one copy of the
 * markup; the pages themselves stay static HTML with no build step.
 */
const LOGO = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
  <path d="M10 1.6 17.5 6v8L10 18.4 2.5 14V6L10 1.6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M6.6 10.2 9 12.6l4.6-4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const NAV = [
  ['/docs', 'Docs'],
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
          </ul>
        </div>
        <div>
          <h3>For agents</h3>
          <ul>
            <li><a href="/openapi.json">OpenAPI spec</a></li>
            <li><a href="/llms.txt">llms.txt</a></li>
            <li><a href="/.well-known/agent-manifest.json">Capability manifest</a></li>
            <li><a href="/mcp/info">MCP server info</a></li>
          </ul>
        </div>
        <div>
          <h3>Operations</h3>
          <ul>
            <li><a href="/security">Security posture</a></li>
            <li><a href="/healthz">Health</a></li>
            <li><a href="/readyz">Readiness</a></li>
          </ul>
        </div>
      </div>
      <p style="margin-top:2rem">
        Ratchet gates side effects. It does not execute them, and it never holds your funds.
      </p>
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

export function tabs(container, onSelect) {
  const buttons = [...container.querySelectorAll('.tab')];
  const select = (name) => {
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    onSelect(name);
  };
  for (const b of buttons) b.addEventListener('click', () => select(b.dataset.tab));
  select(buttons[0]?.dataset.tab);
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
