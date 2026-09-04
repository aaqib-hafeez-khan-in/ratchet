// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * Reveal-on-scroll, shared by every page.
 *
 * Three rules this follows, each learned from something that went wrong:
 *
 *   Content is visible by default. The hidden state is only opted into once
 *   this module is actually running, so a script that fails to load leaves a
 *   readable page rather than a blank one.
 *
 *   Do not depend on IntersectionObserver firing. It does not in a hidden tab,
 *   during prerender, or when a browser throttles it — and a page whose text
 *   only appears if an observer cooperates is a page that sometimes has no
 *   text. A plain sweep decides what is visible; several things call it.
 *
 *   Reveal once. Anything that re-animates every time you scroll past reads as
 *   decoration and gets annoying on the second pass.
 *
 * The motion is deliberately small: a short rise and fade. This is a site about
 * not doing things twice by accident, and flamboyant movement would undercut
 * the argument.
 */
const SELECTOR = '[data-reveal]';

export function reveal({ stagger = 0, maxStagger = 320 } = {}) {
  const items = [...document.querySelectorAll(SELECTOR)];
  if (!items.length) return;

  const showAll = () => items.forEach((el) => el.classList.add('is-in'));

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { showAll(); return; }

  // Only now is it safe to hide anything: this line proves the script ran.
  document.documentElement.classList.add('js-reveal');

  if (stagger) {
    // Stagger within a group, not across the page — otherwise the last item on
    // a long page waits absurdly long for no reason.
    const groups = new Map();
    for (const el of items) {
      const key = el.closest('section') ?? document.body;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    }
    for (const list of groups.values()) {
      list.forEach((el, i) =>
        el.style.setProperty('--reveal-delay', `${Math.min(i * stagger, maxStagger)}ms`));
    }
  }

  let queued = false;
  const sweep = () => {
    queued = false;
    const pending = items.filter((el) => !el.classList.contains('is-in'));
    if (!pending.length) { teardown(); return; }
    const limit = innerHeight * 0.92;
    for (const el of pending) {
      if (el.getBoundingClientRect().top < limit) el.classList.add('is-in');
    }
  };
  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(sweep); } };
  function teardown() {
    removeEventListener('scroll', onScroll);
    removeEventListener('resize', onScroll);
    document.removeEventListener('visibilitychange', sweep);
  }

  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  document.addEventListener('visibilitychange', sweep);

  requestAnimationFrame(sweep);   // whatever is already on screen
  setTimeout(sweep, 400);         // if rAF was throttled
  setTimeout(showAll, 2500);      // hard backstop: never leave the page blank
}

/** Tag every direct child section of <main> so pages need no per-page markup. */
export function revealSections({ skip = [], stagger = 0 } = {}) {
  const sections = [...document.querySelectorAll('main > section')];
  for (const s of sections) {
    if (skip.some((sel) => s.matches(sel))) continue;
    const wrap = s.querySelector('.wrap') ?? s;
    wrap.setAttribute('data-reveal', '');
  }
  reveal({ stagger });
}
