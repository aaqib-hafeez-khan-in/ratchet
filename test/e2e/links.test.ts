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
const pages = readdirSync(WEB).filter((f) => f.endsWith('.html'));

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
    for (const page of pages) {
      for (const href of hrefsOf(readFileSync(join(WEB, page), 'utf8'))) {
        if (!href.startsWith('/')) continue;          // external links are not ours to guarantee
        const path = href.split('#')[0]!;
        if (!path || seen.has(path)) continue;
        seen.add(path);
        const r = await app.inject({ method: 'GET', url: path });
        assert.ok(r.statusCode < 400,
          `${page} links to ${path}, which returns ${r.statusCode}`);
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
