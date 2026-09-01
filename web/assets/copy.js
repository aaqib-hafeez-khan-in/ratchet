/**
 * Copy buttons on every code block, site-wide.
 *
 * A visitor could not tell whether Ratchet required a signup. The page answered
 * in prose, which is the weakest kind of answer: it asks to be believed. The
 * strongest answer is a command they can run in ten seconds without an account,
 * and that only works if getting the command out of the page is free.
 *
 * Three things this has to get right:
 *
 *   Never leave a button that does nothing. `navigator.clipboard` is undefined
 *   on a plain-HTTP origin and can be refused outright, so support is checked
 *   before a single button is added, and a failed write says so rather than
 *   claiming success.
 *
 *   Survive re-rendering. Works-with rewrites its results on every keystroke,
 *   and the docs tabs swap their snippets. An observer picks up whatever
 *   appears instead of every caller having to remember to ask.
 *
 *   Copy what is actually runnable. Result lines and shell prompts are there to
 *   show what comes back; pasting them into a terminal gets an error. They are
 *   stripped, and the button says so when it has stripped anything.
 */

/* Only real commands get a button. The site is full of blocks that describe a
   request — "POST /v1/effects/begin" over a JSON body — and those read as code
   but cannot be pasted anywhere. Offering to copy one is a small lie: the user
   pastes it into a terminal and gets an error. Shell commands qualify, and so
   does a block that is entirely a JSON object, because the MCP client configs
   are exactly that and are meant to be pasted into a settings file. */
const SHELL =
  /^\s*(curl|npm|npx|pnpm|yarn|pip|python3?|node|git|docker|brew|export|claude)\s/im;

/* Two different things get written as an ellipsis and only one of them is
   disqualifying. "rk_live_…" is a placeholder: the reader substitutes their own
   key and the snippet works. "[ … ]" is an elision: content has been left out
   and no substitution makes it whole. The difference is whether the ellipsis is
   attached to a word, so that is what this tests. Rejecting both meant the MCP
   config — the single most copied thing on the site — had no button. */
const ELIDED = /(^|[^\w])[…]|\.\.\.\s*$/m;

/* A placeholder the reader must replace before the snippet does anything. */
export const NEEDS_KEY =
  /(rk_live_|rk_test_|Bearer\s|_API_KEY\W*)[^\s"']*(…|\.\.\.)|YOUR_[A-Z_]*KEY/;

export function isCopyable(text) {
  if (ELIDED.test(text)) return false;
  if (SHELL.test(text)) return true;
  const t = text.trim();
  if (!t.startsWith('{')) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

/**
 * Reduce a displayed snippet to the part that can actually be used.
 *
 * Two kinds of surrounding matter get removed. Comment lines above and below a
 * JSON block name the file it goes in and explain a point about it — strict
 * JSON has no comments, so copying them into that file is precisely what breaks
 * the reader's config. And an example response introduced by an arrow is there
 * to show what comes back; pasting it into a terminal is an error.
 */
const isComment = (l) => /^\s*\/\//.test(l);
const isBlank = (l) => !l.trim();

export function runnableText(raw) {
  let lines = raw.split('\n');
  let stripped = false;

  const lead = [...lines];
  while (lead.length && (isComment(lead[0]) || isBlank(lead[0]))) lead.shift();
  if (lead[0]?.trim().startsWith('{')) {
    // Only for a JSON body, where a comment is a syntax error rather than a
    // helpful line the reader would want to keep.
    while (lines.length && (isComment(lines[0]) || isBlank(lines[0]))) {
      if (isComment(lines[0])) stripped = true;
      lines.shift();
    }
    while (lines.length) {
      const last = lines[lines.length - 1];
      if (!isComment(last) && !isBlank(last)) break;
      if (isComment(last)) stripped = true;
      lines.pop();
    }
  }

  const kept = [];
  for (const line of lines) {
    if (/^\s*(→|->)\s/.test(line)) { stripped = true; break; }
    if (/^\s*\$\s/.test(line)) stripped = true;
    kept.push(line.replace(/^\s*\$\s/, ''));   // a prompt is not part of the command
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return { text: kept.join('\n').trim(), stripped };
}

function decorate(pre) {
  if (pre.closest('.copywrap')) return;                 // already done
  const raw = pre.textContent ?? '';
  if (raw.trim().length < 12) return;

  // Judge what would actually be copied, not what is displayed. The hero's
  // example response contains an elided key ("rk_live_…"), and testing the raw
  // block disqualified a perfectly runnable curl over a character that gets
  // stripped before anyone sees it.
  const { text, stripped } = runnableText(raw);
  if (!text || !isCopyable(text)) return;

  const wrap = document.createElement('div');
  wrap.className = 'copywrap';
  pre.parentNode.insertBefore(wrap, pre);
  wrap.appendChild(pre);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.textContent = 'Copy';
  btn.setAttribute('aria-label',
    stripped ? 'Copy, without the surrounding commentary' : 'Copy to clipboard');

  // A screen reader is told the outcome; sighted users get the label change.
  const say = document.createElement('span');
  say.className = 'sr-only';
  say.setAttribute('role', 'status');
  say.setAttribute('aria-live', 'polite');

  let reset;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      // Say so when the snippet will not work as pasted. A config copied with
      // the placeholder still in it fails later, somewhere else, confusingly.
      btn.textContent = NEEDS_KEY.test(text) ? 'Copied — add your key' : 'Copied';
      btn.classList.add('ok');
      // The visible label stays short; the detail goes where it does not crowd
      // the button.
      say.textContent = NEEDS_KEY.test(text)
        ? 'Copied. Replace the placeholder with your API key before using it.'
        : stripped ? 'Copied, without the surrounding commentary' : 'Copied';
    } catch {
      // Do not claim a copy that did not happen — the user would paste nothing
      // and blame their terminal.
      btn.textContent = 'Press ⌘C';
      btn.classList.add('warn');
      say.textContent = 'Copying was blocked; the text is selected instead';
      const r = document.createRange();
      r.selectNodeContents(pre);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
    clearTimeout(reset);
    reset = setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('ok', 'warn');
      say.textContent = '';
    }, 2400);
  });

  wrap.append(btn, say);
}

export function enhanceCopy(root = document) {
  if (!navigator.clipboard?.writeText) return;   // no dead buttons
  root.querySelectorAll('pre').forEach(decorate);
}

/**
 * Catch snippets that arrive after load — search results, docs tabs, and the
 * home page's own flow diagram.
 *
 * The text-node branch is the one that matters. Most pages ship an empty
 * <pre><code> in the HTML and fill it from JavaScript, so at mount time the
 * block has nothing in it to judge and gets skipped. Assigning textContent then
 * shows up here as an added text node, not an added element — watching only for
 * elements silently missed half the code on the site.
 */
export function watchForCode() {
  if (!navigator.clipboard?.writeText) return;
  const seen = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType === 3) {
          const pre = node.parentElement?.closest('pre');
          if (pre) decorate(pre);
          continue;
        }
        if (node.nodeType !== 1) continue;
        if (node.matches?.('pre')) decorate(node);
        node.querySelectorAll?.('pre').forEach(decorate);
        // A pre filled by replacing an ancestor's innerHTML arrives as an
        // element whose own parent chain may already be inside a pre.
        const host = node.parentElement?.closest('pre');
        if (host) decorate(host);
      }
    }
  });
  seen.observe(document.body, { childList: true, subtree: true, characterData: false });
}
