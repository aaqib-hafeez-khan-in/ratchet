/**
 * Structured data is a public claim, so it is tested like one.
 *
 * Google reads the JSON-LD on these pages and can show its contents directly in
 * results. A hand-maintained block drifts: the FAQ answer changes, the schema
 * does not, and a rich result quotes an answer the page no longer gives —
 * wrong, in public, attributed to us. Worse than having no rich result at all.
 *
 * So the blocks are generated from the pages by `npm run schema`, and this
 * asserts they are still in sync.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (p: string) => readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8');
const blocks = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]!) as Record<string, unknown>);

describe('structured data', () => {
  test('every JSON-LD block on every page is valid JSON', () => {
    for (const page of ['index.html', 'faq.html',
      'notes/what-happens-when-step-five-fails.html',
      'notes/idempotency-keys-are-broken-on-macos.html']) {
      const found = blocks(read(page));
      assert.ok(found.length > 0, `${page} has no structured data`);
      for (const b of found) assert.equal(b['@context'], 'https://schema.org');
    }
  });

  test('the FAQ schema matches the questions actually on the page', () => {
    const html = read('faq.html');
    const onPage = [...html.matchAll(/<summary>(.*?)<\/summary>/gs)]
      .map((m) => m[1]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

    const faq = blocks(html).find((b) => b['@type'] === 'FAQPage');
    assert.ok(faq, 'the FAQ page must carry FAQPage structured data');
    const inSchema = (faq.mainEntity as Array<{ name: string }>).map((q) => q.name);

    assert.deepEqual(inSchema, onPage,
      'the FAQ schema has drifted from the page — run: npm run schema');
  });

  /**
   * The generator is the source of truth; this proves running it is a no-op,
   * which is the only way to know the committed output is current.
   */
  test('the generated schema is up to date', () => {
    try {
      execFileSync('node', ['scripts/build-schema.mjs', '--check'],
        { cwd: new URL('../..', import.meta.url), stdio: 'pipe' });
    } catch (err) {
      const out = (err as { stdout?: Buffer; stderr?: Buffer });
      assert.fail('structured data is stale — run `npm run schema`.\n'
        + `${out.stdout?.toString() ?? ''}${out.stderr?.toString() ?? ''}`);
    }
  });

  // The social profiles are claimed here so Google treats them as the same
  // entity. Without it a lookalike account can outrank the real one.
  test('the homepage claims the brand accounts as the same entity', () => {
    const org = blocks(read('index.html')).find((b) => b['@type'] === 'Organization');
    assert.ok(org, 'the homepage must carry Organization structured data');
    const sameAs = org.sameAs as string[];
    assert.ok(sameAs.some((u) => u.includes('x.com')), 'X profile not claimed');
    assert.ok(sameAs.some((u) => u.includes('instagram.com')), 'Instagram profile not claimed');
    assert.equal((org.parentOrganization as { name: string }).name, 'Deimos.MX');
  });
});

describe('the brand accounts', () => {
  const handles = ['https://x.com/ratchetgate', 'https://www.instagram.com/ratchetgate'];

  /**
   * Two claims about the same accounts, made in two places for two readers.
   * `sameAs` is for a crawler that parses JSON-LD; `rel="me"` on a real link is
   * for one that only reads markup. They have to agree, or the entity claim is
   * weaker than either would be alone.
   */
  test('the footer links match what the schema claims', () => {
    const partials = readFileSync(
      new URL('../../web/assets/partials.js', import.meta.url), 'utf8');
    const org = blocks(read('index.html')).find((b) => b['@type'] === 'Organization');
    const sameAs = org!.sameAs as string[];

    for (const url of handles) {
      assert.ok(sameAs.includes(url), `${url} is not claimed in the Organization schema`);
      assert.ok(partials.includes(url), `${url} is claimed in schema but not linked in the footer`);
    }
    assert.match(partials, /rel="noopener me"/,
      'the profile links must carry rel="me" — it is the same claim in the form a '
      + 'markup-only crawler can see');
  });
});
