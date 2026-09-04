// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * "Was this page clear?"
 *
 * Every usability problem we have fixed arrived as a screenshot forwarded by
 * the operator, days later. The people who could not follow a page had no way
 * to say so from the page. This is that way.
 *
 * Design constraints, in the order they mattered:
 *
 *   It must not look like a survey. One quiet line at the end of the content,
 *   two buttons, no modal, no floating badge, nothing that follows the reader
 *   down the page. If it is annoying it will be ignored, and ignored feedback
 *   is worse than none because it looks like everything is fine.
 *
 *   Yes must cost one click and nothing else. Most readers are fine; making
 *   them confirm a form to say so would mean we only ever hear from people
 *   angry enough to type, which is the sample we already had.
 *
 *   It must never block the page. The request is fire-and-forget, failures are
 *   swallowed, and the thank-you is shown whether or not the network worked. A
 *   reader who took the trouble to tell us something should not then be shown
 *   an error about our own infrastructure.
 */
const KEY = 'ratchet.fb.';

/* Coarse enough to be useless for identifying anyone, precise enough to
   reproduce a layout complaint. */
const widthBucket = () => {
  const w = innerWidth;
  if (w < 640) return 'phone';
  if (w < 1024) return 'tablet';
  if (w < 1600) return 'desktop';
  return 'wide';
};

const already = (path) => {
  try { return localStorage.getItem(KEY + path) !== null; } catch { return false; }
};
const remember = (path) => {
  try { localStorage.setItem(KEY + path, '1'); } catch { /* private mode */ }
};

async function post(body) {
  try {
    await fetch('/v1/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    });
  } catch { /* Their opinion is not worth an error message to them. */ }
}

export function mountFeedback() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const main = document.getElementById('main');
  if (!main || already(path)) return;
  // The console is an application, not a page to be understood, and asking
  // there would be noise in the middle of someone's work.
  if (path === '/console') return;

  /* Match the column the page itself uses. Hardcoding "wrap narrow" put the
     question 80px inside the heading on every wide page, which reads as a
     third-party widget bolted on rather than part of the page. */
  const hostWrap = main.querySelector('.wrap');
  const wrapClass = hostWrap ? hostWrap.className : 'wrap narrow';

  const box = document.createElement('section');
  box.className = 'fb';
  box.innerHTML = `
    <div class="${wrapClass}">
      <div class="fb-ask">
        <span class="fb-q">Was this page clear?</span>
        <span class="fb-btns">
          <button type="button" class="fb-btn" data-clear="1">Yes</button>
          <button type="button" class="fb-btn" data-clear="0">No</button>
        </span>
      </div>
    </div>`;
  main.appendChild(box);

  const ask = box.querySelector('.fb-ask');

  const thanks = (msg) => {
    ask.innerHTML = `<span class="fb-q fb-done">${msg}</span>`;
    remember(path);
  };

  /* Clicking No is already the answer; the message is a bonus. Posting on the
     click AND on submit would count one unhappy reader twice, so the vote is
     sent once — on submit if they write something, or on the way out if they
     opened the box and left. keepalive is what makes the second one arrive. */
  let sent = false;
  let opened = false;
  const sendOnce = (body) => { if (!sent) { sent = true; post(body); } };
  addEventListener('pagehide', () => {
    if (opened) sendOnce({ path, was_clear: false, viewport: widthBucket() });
  });

  const openForm = () => {
    opened = true;
    ask.innerHTML = `
      <form class="fb-form" novalidate>
        <label for="fb-msg">What was unclear? Quoting the sentence helps most.</label>
        <textarea id="fb-msg" name="message" rows="3" maxlength="2000"
                  placeholder="The bit about claiming a workspace…"></textarea>
        <div class="fb-row">
          <input type="email" name="reply_to" maxlength="254" autocomplete="email"
                 placeholder="Email, only if you want an answer">
          <button class="btn small" type="submit">Send</button>
        </div>
        <p class="fb-note">Goes to the person who wrote the page. We store no IP and
           set no cookie for this.</p>
        <div class="fb-hp" aria-hidden="true">
          <label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
        </div>
      </form>`;
    const form = ask.querySelector('form');
    ask.querySelector('#fb-msg')?.focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = new FormData(form);
      sendOnce({
        path,
        was_clear: false,
        viewport: widthBucket(),
        message: String(data.get('message') ?? '').trim() || undefined,
        // An empty string fails the schema's email format, so send nothing.
        reply_to: String(data.get('reply_to') ?? '').trim() || undefined,
        website: String(data.get('website') ?? '') || undefined,
      });
      thanks('Thank you — that is genuinely useful.');
    });
  };

  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.fb-btn');
    if (!btn) return;
    if (btn.dataset.clear === '1') {
      post({ path, was_clear: true, viewport: widthBucket() });
      thanks('Thanks.');
      return;
    }
    openForm();
  });
}
