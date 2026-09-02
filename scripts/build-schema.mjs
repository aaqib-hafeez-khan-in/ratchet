/**
 * Generate the structured data that Google reads, from the pages themselves.
 *
 * Hand-written JSON-LD drifts. The FAQ answers change, nobody remembers the
 * schema block at the top of the file, and Google carries on showing a rich
 * result that quotes an answer the page no longer gives — which is worse than
 * having no rich result, because it is wrong in public and attributed to us.
 *
 * So it is derived. Run this after editing the FAQ or publishing a note, and a
 * test asserts the output is in sync with the page it came from.
 *
 *   node scripts/build-schema.mjs         # write
 *   node scripts/build-schema.mjs --check # fail if stale (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const SITE = 'https://ratchetgate.com';
const check = process.argv.includes('--check');

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const MARK = {
  open: '<!-- schema:auto -->',
  close: '<!-- /schema:auto -->',
};

/** Replace the generated block, or insert it just before </head>. */
function inject(html, block) {
  const wrapped = `${MARK.open}\n${block}\n${MARK.close}`;
  const existing = new RegExp(`${MARK.open}[\\s\\S]*?${MARK.close}`);
  if (existing.test(html)) return html.replace(existing, wrapped);
  return html.replace('</head>', `${wrapped}\n</head>`);
}

const ld = (obj) =>
  `<script type="application/ld+json">\n${JSON.stringify(obj, null, 1)}\n</script>`;

// ---------------------------------------------------------------- FAQ
function faq() {
  const path = join(WEB, 'faq.html');
  const html = readFileSync(path, 'utf8');
  const pairs = [...html.matchAll(
    /<summary>(.*?)<\/summary>\s*<div class="faq-body">\s*<p>(.*?)<\/p>/gs)];
  if (pairs.length < 5) throw new Error(`only ${pairs.length} FAQ pairs parsed — the markup changed`);

  const block = ld({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: pairs.map(([, q, a]) => ({
      '@type': 'Question',
      name: strip(q),
      acceptedAnswer: { '@type': 'Answer', text: strip(a) },
    })),
  });
  return [path, inject(html, block), `FAQPage · ${pairs.length} questions`];
}

// ---------------------------------------------------------------- notes
function note(file) {
  const path = join(WEB, 'notes', file);
  const html = readFileSync(path, 'utf8');
  const slug = file.replace(/\.html$/, '');
  const title = strip(html.match(/<title>(.*?)<\/title>/s)?.[1] ?? '')
    .replace(/\s*[—|]\s*Ratchet\s*$/, '');
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
  // Prefer the date the page already shows over one invented here.
  const date = html.match(/datetime="(\d{4}-\d{2}-\d{2})"/)?.[1]
    ?? html.match(/<loc>[^<]*<\/loc><lastmod>(\d{4}-\d{2}-\d{2})/)?.[1]
    ?? '2026-09-01';

  const block = ld({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: title,
    description: desc,
    datePublished: date,
    dateModified: date,
    url: `${SITE}/notes/${slug}`,
    mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE}/notes/${slug}` },
    image: `${SITE}/assets/og.png`,
    author: { '@type': 'Organization', name: 'Deimos.MX', url: 'https://deimos.mx' },
    publisher: {
      '@type': 'Organization', name: 'Ratchet', url: SITE,
      logo: { '@type': 'ImageObject', url: `${SITE}/assets/mark.svg` },
    },
  });
  return [path, inject(html, block), `BlogPosting · ${slug}`];
}

// ---------------------------------------------------------------- home
function home() {
  const path = join(WEB, 'index.html');
  const html = readFileSync(path, 'utf8');
  const block = [
    ld({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Ratchet',
      url: SITE,
      logo: `${SITE}/assets/mark.svg`,
      description: 'An effect gate for AI agents. Ask before you act, so the same '
        + 'real-world side effect is attempted at most once.',
      parentOrganization: { '@type': 'Organization', name: 'Deimos.MX', url: 'https://deimos.mx' },
      // Claiming the social profiles as the same entity is what lets Google
      // show them together and stops a lookalike account outranking the real one.
      sameAs: [
        'https://x.com/ratchetgate',
        'https://www.instagram.com/ratchetgate',
        'https://github.com/thearchitect0x-glitch/ratchet',
      ],
    }),
    ld({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Ratchet',
      url: SITE,
      publisher: { '@type': 'Organization', name: 'Ratchet', url: SITE },
    }),
  ].join('\n');
  return [path, inject(html, block), 'Organization + WebSite'];
}

const jobs = [home(), faq(),
  note('what-happens-when-step-five-fails.html'),
  note('idempotency-keys-are-broken-on-macos.html')];

let stale = 0;
for (const [path, next, label] of jobs) {
  const current = readFileSync(path, 'utf8');
  if (current === next) { console.log(`  ok     ${label}`); continue; }
  stale++;
  if (check) { console.log(`  STALE  ${label}`); continue; }
  writeFileSync(path, next);
  console.log(`  wrote  ${label}`);
}

if (check && stale) {
  console.error(`\n${stale} page(s) have structured data that no longer matches the page.`);
  console.error('Run: npm run schema');
  process.exit(1);
}
