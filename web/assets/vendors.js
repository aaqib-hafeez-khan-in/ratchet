// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
import { mountChrome } from '/assets/partials.js';
import { reveal } from '/assets/reveal.js';
mountChrome('/vendors');

/**
 * The vendor directory, for people.
 *
 * This data already existed and was already correct. It was reachable only as
 * JSON at /v1/vendors, linked once from a sentence in the middle of the home
 * page. A user told us Figma was missing; Figma had been in the directory for a
 * day. It was missing from the site, not from the product.
 *
 * Rendered from that endpoint rather than copied into the HTML, so the page
 * cannot drift from what the gate actually believes. A hardcoded table would be
 * wrong within a month and nobody would notice.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const card = (v) => `
  <article class="vcard${v.enforced ? ' yes' : ''}">
    <h3>${esc(v.vendor)}</h3>
    <p class="vplace">${esc(v.placement)}</p>
    <dl class="vmeta">
      <div><dt>Remembers</dt><dd>${esc(v.retention)}</dd></div>
      <div><dt>Max length</dt><dd>${esc(v.max_length ?? v.maxLength)}</dd></div>
    </dl>
    <p class="small dim">${esc(v.note)}</p>
  </article>`;

const group = (title, blurb, list) => !list.length ? '' : `
  <div class="vgroup">
    <h2>${esc(title)} <span class="vcount">${list.length}</span></h2>
    <p class="dim" style="max-width:60ch">${blurb}</p>
    <div class="vgrid">${list.map(card).join('')}</div>
  </div>`;

const root = document.getElementById('vendors');

try {
  const res = await fetch('/v1/vendors', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { vendors } = await res.json();

  const yes = vendors.filter((v) => v.enforced);
  const no = vendors.filter((v) => !v.enforced);

  root.innerHTML =
    group('Refuses a repeat', 
      'Send the same key twice and the vendor replays its first answer instead of doing the '
      + 'work again. Composed with the gate, a duplicate is stopped by them — whether or not '
      + 'your agent cooperated with us.', yes)
    + group('Does not',
      'These have no documented idempotency key on the operations that matter. A retry here '
      + 'really can send the message or make the change twice, whatever your code does. The '
      + 'gate still records the attempt and still tells you when an outcome is unknown — it '
      + 'just cannot make the vendor refuse.', no)
    + `<p class="small faint" style="margin-top:2rem">
         Every entry was checked against the vendor's own documentation, and the date we
         checked is in the note. We list the ones that do not deduplicate, including the ones
         we would rather claim. Same data as
         <a href="/v1/vendors">/v1/vendors</a>.</p>`;

  /*
   * Filtering, once the list exists.
   *
   * Twelve vendors is scannable and this list will grow, so the field is here
   * before it needs to be rather than after somebody complains. It searches the
   * note as well as the name, because "does anything here mention webhooks" is a
   * real question and matching only the title would answer it wrongly.
   *
   * Nothing is fetched on keystroke: the whole directory is already in the page.
   */
  const q = document.getElementById('vq');
  if (q) {
    const cards = [...root.querySelectorAll('.vcard')];
    const groups = [...root.querySelectorAll('.vgroup')];
    q.addEventListener('input', () => {
      const term = q.value.trim().toLowerCase();
      for (const c of cards) {
        c.hidden = term.length > 0 && !c.textContent.toLowerCase().includes(term);
      }
      // A heading with nothing under it reads as a bug, so a group whose cards
      // are all hidden hides too — and its count reflects what is showing.
      for (const g of groups) {
        const shown = [...g.querySelectorAll('.vcard')].filter((c) => !c.hidden).length;
        g.hidden = shown === 0;
        const badge = g.querySelector('.vcount');
        if (badge) badge.textContent = String(shown);
      }
      const none = root.querySelectorAll('.vcard:not([hidden])').length === 0;
      let msg = document.getElementById('vnone');
      if (none && !msg) {
        msg = document.createElement('p');
        msg.id = 'vnone';
        msg.className = 'dim';
        msg.textContent = 'No vendor here matches that. A vendor missing from this list is '
          + 'not one Ratchet cannot gate — the directory only records which vendors add '
          + 'enforcement of their own.';
        root.appendChild(msg);
      } else if (!none && msg) {
        msg.remove();
      }
    });
  }

  reveal();
} catch (err) {
  // Never leave a spinner. Say what happened and hand over the raw source.
  root.innerHTML = `
    <p class="dim">The directory could not be loaded (${esc(err.message)}).
       It is served as JSON at <a href="/v1/vendors">/v1/vendors</a>.</p>`;
}
