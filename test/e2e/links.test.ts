/**
 * A dead link on a marketing page is a small bug that reads as carelessness,
 * and a placeholder like github.com/OWNER/... shipped to production reads as
 * worse. Both had happened, so both are now checked.
 *
 * Only real href attributes are examined — code samples legitimately contain
 * https://your-host/... and hooks.example.com, and should keep doing so.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../../src/api/app.js';
import { closePool } from '../helpers.js';

const WEB = join(import.meta.dirname, '../../web');
const ROOT = join(import.meta.dirname, '../..');
const pages = readdirSync(WEB).filter((f) => f.endsWith('.html'));

/**
 * The nav and footer are rendered from JavaScript, so scanning only .html files
 * missed every link in the site chrome — which is most of the links on every
 * page. They were fine, but by luck rather than by test.
 */
const CHROME = ['assets/partials.js', 'assets/works-with.js', 'assets/vendors.js'];

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { app = await buildApp(); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

/** hrefs only — never the contents of a <pre> or <code> block. */
function hrefsOf(html: string): string[] {
  const stripped = html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code[\s\S]*?<\/code>/g, '');
  return [...stripped.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

const PLACEHOLDERS = [/\/OWNER\//, /your-host/, /example\.com/, /TODO/i, /CHANGEME/i];

describe('site links', () => {
  test('no placeholder ever reaches a real href', () => {
    for (const page of pages) {
      for (const href of hrefsOf(readFileSync(join(WEB, page), 'utf8'))) {
        for (const p of PLACEHOLDERS) {
          assert.doesNotMatch(href, p, `${page} ships a placeholder link: ${href}`);
        }
      }
    }
  });

  test('every internal link resolves', async () => {
    const seen = new Set<string>();
    const sources = [
      ...pages.map((p) => [p, readFileSync(join(WEB, p), 'utf8')] as const),
      ...CHROME.map((f) => [f, readFileSync(join(WEB, f), 'utf8')] as const),
    ];
    for (const [page, content] of sources) {
      for (const href of hrefsOf(content)) {
        if (!href.startsWith('/')) continue;          // external links are not ours to guarantee
        if (href.includes('${')) continue;            // template placeholder, not a real link
        const path = href.split('#')[0]!;
        if (!path || seen.has(path)) continue;
        seen.add(path);
        const r = await app.inject({ method: 'GET', url: path });
        // /workerz reports whether lease expiry is running, and 503 is its
        // documented answer for "it is not" — exactly the case in a test run,
        // where no worker has checked in. Without this the test passed only
        // because another test file happened to write a heartbeat first.
        const ok = path === '/workerz'
          ? r.statusCode === 200 || r.statusCode === 503
          : r.statusCode < 400;
        assert.ok(ok, `${page} links to ${path}, which returns ${r.statusCode}`);
      }
    }
    assert.ok(seen.size > 5, 'link extraction found almost nothing — the regex is wrong');
  });

  test('robots.txt does not block the integration beacon', async () => {
    const robots = (await app.inject({ method: 'GET', url: '/robots.txt' })).body;
    assert.match(robots, /Allow: \/v1\/integrate/,
      'the beacon is under /v1/, which is disallowed — it needs an explicit Allow');
  });
});

describe('stylesheet integrity', () => {
  // A stray brace silently disables every rule after it. This shipped once:
  // an offset-based edit removed a block and left its closing brace behind,
  // and the only symptom was elements staying invisible on one page.
  test('braces balance and never close below zero', () => {
    const css = readFileSync(join(WEB, 'assets/style.css'), 'utf8');
    let depth = 0;
    let line = 0;
    for (const [i, l] of css.split('\n').entries()) {
      depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
      if (depth < 0 && !line) line = i + 1;
    }
    assert.equal(line, 0, `a stray closing brace at line ${line} disables every rule after it`);
    assert.equal(depth, 0, `stylesheet ends at depth ${depth}; a rule is unclosed`);
  });

  test('the reveal rules the pages depend on are present', () => {
    const css = readFileSync(join(WEB, 'assets/style.css'), 'utf8');
    assert.match(css, /\.js-reveal \[data-reveal\]\s*\{/);
    assert.match(css, /\.js-reveal \[data-reveal\]\.is-in\s*\{/);
  });
});

describe('published retention claims match the code', () => {
  // A privacy page that overstates how long data is kept is a promise the
  // reaper quietly breaks. This drifted once: the page said anonymous
  // workspaces were kept unless "never used", while the sweep deletes any
  // unclaimed workspace with no effects in the window.
  test('the anonymous window on /privacy is the window the reaper uses', () => {
    const reaper = readFileSync(join(ROOT, 'src/worker/reaper.ts'), 'utf8');
    const sweep = reaper.slice(reaper.indexOf('w.anonymous'), reaper.indexOf('w.anonymous') + 400);
    const days = [...sweep.matchAll(/interval '(\d+) days'/g)].map((m) => m[1]);
    assert.ok(days.length >= 1, 'could not read the anonymous sweep interval');
    const page = readFileSync(join(WEB, 'privacy.html'), 'utf8');
    const claim = page.slice(page.indexOf('Anonymous workspaces'), page.indexOf('Anonymous workspaces') + 400);
    for (const d of days) {
      assert.match(claim, new RegExp(`${d} days`),
        `the sweep uses ${d} days; /privacy does not say so`);
    }
    assert.match(claim, /inactivity/,
      'the sweep is activity-based, so the page must not imply unused-only deletion');
  });
});

describe('no stale hostnames in anything the site renders', () => {
  /**
   * works-with.js carried a hardcoded ratchet-gate.fly.dev URL straight through
   * the domain cutover. Nothing caught it because the snippet is rendered
   * client-side: it never appears in the served HTML, so grepping pages found
   * nothing, and the link tests only look at .html files.
   */
  const assets = readdirSync(join(WEB, 'assets')).filter((f) => f.endsWith('.js'));

  test('no deployment hostname is hardcoded in a script', () => {
    for (const f of assets) {
      const src = readFileSync(join(WEB, 'assets', f), 'utf8');
      const hits = src.match(/https?:\/\/[a-z0-9.-]*(fly\.dev|herokuapp|onrender|vercel\.app)/gi);
      assert.equal(hits, null,
        `${f} hardcodes a deployment host (${hits?.join(', ')}). Use location.origin.`);
    }
  });

  test('no localhost URL is shown to a visitor', () => {
    for (const f of assets) {
      const src = readFileSync(join(WEB, 'assets', f), 'utf8');
      // A localhost default for a dev tool is fine; one inside a displayed
      // snippet is not.
      const shown = src.match(/snippet:[\s\S]{0,400}?localhost/gi);
      assert.equal(shown, null, `${f} shows a localhost URL in a snippet`);
    }
  });

  test('scripts that display an API URL derive it from the page', () => {
    for (const f of ['docs.js', 'start.js', 'works-with.js']) {
      const src = readFileSync(join(WEB, 'assets', f), 'utf8');
      assert.match(src, /const BASE = location\.origin/,
        `${f} shows API URLs and must derive the host, not hardcode it`);
    }
  });
});
