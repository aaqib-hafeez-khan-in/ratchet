// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Shared chrome. Rendered client-side so every page ships one copy of the
 * markup; the pages themselves stay static HTML with no build step.
 */
import { enhanceCopy, watchForCode } from '/assets/copy.js';
import { mountFeedback } from '/assets/feedback.js';

const LOGO = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
  <path d="M10 1.6 17.5 6v8L10 18.4 2.5 14V6L10 1.6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M6.6 10.2 9 12.6l4.6-4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const NAV = [
  ['/start', 'Get started'],
  ['/docs', 'Docs'],
  ['/works-with', 'Works with'],
  // The vendor directory answers "does Stripe refuse a repeat, does Slack" and
  // is the only page here a stranger would link to unprompted. It was reachable
  // from one sentence in the middle of the home page and the footer, which a
  // reader told us was tucked away — they were right. Eight items fits: the
  // mobile strip already scrolls with a fade at each end.
  ['/vendors', 'Vendors'],
  ['/notes', 'Notes'],
  ['/pricing', 'Pricing'],
  // Fraud sits next to Security on purpose: they are the two pages a risk
  // reader looks for, and one is useless to them without the other.
  ['/fraud', 'Fraud'],
  ['/security', 'Security'],
  ['/console', 'Console'],
];

export function mountChrome(current) {
  // Every page routes through here, so this is the one place that reaches all
  // of them without a per-page edit that someone will forget on the next page.
  enhanceCopy();
  watchForCode();
  mountFeedback();

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
            <li><a href="/simple">Start here — in plain words</a></li>
            <li><a href="/docs">Documentation</a></li>
            <li><a href="/faq">Questions</a></li>
            <li><a href="/pricing">Pricing</a></li>
            <li><a href="/benchmark">Benchmark &mdash; the same job, twice</a></li>
            <li><a href="/fraud">Fraud &amp; risk controls</a></li>
            <li><a href="/console">Operator console</a></li>
            <li><a href="/docs#groups">Rollback groups</a></li>
          </ul>
        </div>
        <div>
          <h3>Works with</h3>
          <ul>
            <li><a href="/works-with">Where your agent runs</a></li>
            <li><a href="/vendors">What your agent acts on</a></li>
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
            <li><a href="/status">Status</a></li>
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
        <div class="footer-id">
        <p class="social" style="margin:0">
          <a href="https://x.com/ratchetgate" target="_blank" rel="noopener me" aria-label="Ratchet on X">
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            <span>X</span>
          </a>
          <a href="https://www.instagram.com/ratchetgate" target="_blank" rel="noopener me" aria-label="Ratchet on Instagram">
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5.5"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.6" cy="6.4" r="1.2" fill="currentColor" stroke="none"/></svg>
            <span>Instagram</span>
          </a>
        </p>
        <a class="by-deimos" href="https://deimos.mx" target="_blank" rel="noopener noreferrer">
          <svg viewBox="0 0 100 66" role="img" aria-label="Deimos"> <defs>  <linearGradient id="deimosTri" x1="0.15" y1="0" x2="0.5" y2="1">   <stop offset="0" stop-color="currentColor" stop-opacity="0.55"/>   <stop offset="1" stop-color="currentColor" stop-opacity="0.18"/>  </linearGradient> </defs> <g fill="none" stroke="currentColor" stroke-width="2.2">  <ellipse cx="50" cy="33" rx="45" ry="15" transform="rotate(26 50 33)"/>  <ellipse cx="50" cy="33" rx="45" ry="15" transform="rotate(-26 50 33)"/> </g> <path d="M50 9 L76 55 H24 Z" fill="url(#deimosTri)" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>
          <span>Powered by <b>Deimos</b></span>
        </a>
        </div>
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
