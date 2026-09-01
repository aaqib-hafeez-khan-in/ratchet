import { mountChrome } from '/assets/partials.js';
mountChrome('/faq');

/**
 * Open the item a link points at.
 *
 * The answers are collapsed so the page reads as a calm list of questions
 * rather than a wall. That breaks deep links: /faq#allowance would scroll to a
 * closed <details> and show the reader a heading with no answer under it, which
 * is worse than not linking at all. Other pages link straight to #allowance,
 * #figma, #mcp and #learns, so those have to open.
 */
const openTarget = () => {
  const id = location.hash.slice(1);
  if (!id) return;
  const el = document.getElementById(id);
  if (el instanceof HTMLDetailsElement) {
    el.open = true;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
  }
};

openTarget();
addEventListener('hashchange', openTarget);
