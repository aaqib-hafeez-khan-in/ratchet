/**
 * Tell a human that production is unhealthy.
 *
 * The uptime probe has been able to detect a dead worker for a while. What it
 * could not do is reach anybody: the only notification was GitHub emailing the
 * repository owner when a scheduled workflow fails, which is generic, easy to
 * filter, and says nothing about severity. That is the same gap the site had
 * before the feedback letterbox — detection built, delivery skipped.
 *
 * This sends through Resend, which already sends Ratchet's own transactional
 * mail, so it introduces no new vendor. It runs inside GitHub Actions rather
 * than inside the product, because an alert path that depends on the thing it
 * is watching is not an alert path.
 *
 * Honest about what it is: a notification, not a page. If nobody is looking at
 * a phone at 03:00, this does not wake them. Wiring a real push channel is a
 * ten-minute change once someone decides which one — see docs/handoff/ALERTING.md.
 *
 *   node scripts/alert.mjs down    "<summary>"
 *   node scripts/alert.mjs recovered "<summary>"
 */
const [, , kind, summary = ''] = process.argv;

const TO = process.env.ALERT_EMAIL;
const KEY = process.env.ALERT_EMAIL_KEY;
const FROM = process.env.ALERT_EMAIL_FROM ?? 'Ratchet alerts <alerts@mail.ratchetgate.com>';
const RUN = process.env.RUN_URL ?? '';
const STREAK = Number.parseInt(process.env.FAIL_STREAK ?? '1', 10);

if (!['down', 'recovered', 'test', 'check'].includes(kind)) {
  console.error('usage: alert.mjs <down|recovered|test|check> "<summary>"');
  process.exit(2);
}

/**
 * Describe ALERT_EMAIL without revealing it.
 *
 * These logs are public, because the repository is. An address is not a
 * credential but it is not ours to publish either, so this reports length and a
 * handful of booleans — enough to tell a trailing newline from a display name
 * from a value that was never set.
 */
const shapeOf = (v) => ({
  length: v.length,
  hasAt: v.includes('@'),
  domainHasDot: v.split('@').pop()?.includes('.') ?? false,
  hasWhitespace: /\s/.test(v),
  hasQuotes: /["']/.test(v),
  hasAngleBrackets: /[<>]/.test(v),
  startsAlphanumeric: /^[A-Za-z0-9]/.test(v),
  endsAlphanumeric: /[A-Za-z0-9]$/.test(v),
});

/* Deliberately permissive: this is here to catch a mangled value, not to
   adjudicate what RFC 5321 permits. Anything this rejects, Resend will too. */
const LOOKS_LIKE_EMAIL = /^[^\s@<>"',]+@[^\s@<>"',]+\.[^\s@<>"',]+$/;

if (kind === 'check') {
  if (!TO) {
    console.error('ALERT_EMAIL is not set at all.');
    process.exit(1);
  }
  console.log(`ALERT_EMAIL shape: ${JSON.stringify(shapeOf(TO), null, 2)}`);
  console.log(KEY ? 'ALERT_EMAIL_KEY: set' : 'ALERT_EMAIL_KEY: NOT SET');
  if (!LOOKS_LIKE_EMAIL.test(TO)) {
    console.error('');
    console.error('That is not a usable address. Read the shape above:');
    console.error('  hasWhitespace true      -> a trailing newline or a stray space');
    console.error('  hasAngleBrackets true   -> a display name like "Ops <a@b.com>"');
    console.error('  hasAt false             -> not an address at all');
    console.error('  length 0                -> the secret is empty');
    process.exit(1);
  }
  console.log('');
  console.log('Looks like a usable address. Run the test alert to confirm delivery.');
  process.exit(0);
}

/**
 * Whether a repeat "still down" notice is worth sending.
 *
 * The probe runs every fifteen minutes and this used to mail on every failing
 * run, so a day-long outage cost 96 emails. That is the whole free sending
 * quota, shared with the product's own transactional mail — and on 2 Sep 2026
 * it spent it: two customers' welcome mail, carrying their verification links,
 * was refused for quota and then thrown away. An alert channel that destroys
 * signups while telling you about an outage is worse than a quiet one.
 *
 * So the notices thin out as the outage lengthens. The first three checks
 * (45 minutes) each send, then hourly for six hours, then every four hours.
 * Nothing is lost — the run history and GitHub's own failure mail still show
 * every failed check. What stops is repeating a fact already delivered.
 *
 * Recovery always sends. The end of an outage is news every time.
 */
export function shouldNotify(streak) {
  if (streak <= 3) return true;        // first 45 minutes
  if (streak <= 24) return streak % 4 === 0;   // hourly, to six hours
  return streak % 16 === 0;            // then four-hourly
}

if (kind === 'down' && !shouldNotify(STREAK)) {
  console.log(JSON.stringify({
    level: 'info', svc: 'alert', msg: 'suppressed a repeat notice',
    streak: STREAK,
    why: 'already reported; the sending quota is shared with customer mail',
  }));
  process.exit(0);
}

// Absent configuration is not a failure. The workflow still fails and GitHub
// still emails; this is an upgrade to that, not a replacement for it. Exiting
// non-zero here would turn "no alert channel configured" into a second alarm.
if (!TO || !KEY) {
  console.log('No ALERT_EMAIL / ALERT_EMAIL_KEY configured — skipping the alert.');
  console.log('Set them to have failures mailed to a person:');
  console.log('  gh secret set ALERT_EMAIL --repo <owner>/<repo>');
  console.log('  gh secret set ALERT_EMAIL_KEY --repo <owner>/<repo>');
  process.exit(0);
}

/* The subject is the whole message on a lock screen, so it carries the state
   and the consequence rather than a service name and a timestamp. */
const subject = kind === 'test'
  ? 'Ratchet alert test — this is not an outage'
  : kind === 'down'
  ? (STREAK > 1
    ? `RATCHET DOWN — still failing (${STREAK} checks)`
    : 'RATCHET DOWN — production probe failed')
  : 'Ratchet recovered — probe is passing again';

/* An untested alert channel is worse than none: it is a thing everyone
   believes in and nobody has seen work. This is how you see it work. */
const body = kind === 'test'
  ? [
    'Nothing is wrong. Somebody pressed the test button.',
    '',
    'If you are reading this, the alert path works end to end: GitHub Actions',
    'reached Resend, Resend reached you, and the address in ALERT_EMAIL is the',
    'right one.',
    '',
    'A real alert looks like this, with RATCHET DOWN in the subject and the',
    'failing check named in the body.',
    '',
    RUN ? `Run: ${RUN}` : '',
  ].join('\n')
  : kind === 'down'
  ? [
    'The production probe failed.',
    '',
    summary || '(no detail captured)',
    '',
    'The failure that matters most:',
    '',
    '  /workerz 503 — lease expiry has stopped. Effects sit at "pending" for',
    '  ever and every retry is answered "in_flight", with no error anywhere.',
    '  Two worker replicas run, so this means BOTH are gone or wedged.',
    '',
    '  AT-MOST-ONCE VIOLATED — the same idempotency key was authorised twice.',
    '  This is the core guarantee. Stop and investigate before anything else.',
    '',
    `Consecutive failed checks: ${STREAK}`,
    RUN ? `Run: ${RUN}` : '',
    '',
    'Runbook: docs/handoff/RECOVERY.md',
  ].join('\n')
  : [
    'The production probe is passing again.',
    '',
    summary || '',
    RUN ? `Run: ${RUN}` : '',
    '',
    'Worth checking what happened before closing it out — a probe that fails',
    'and recovers on its own is usually a restart, and a restart nobody asked',
    'for is worth understanding.',
  ].join('\n');

if (!LOOKS_LIKE_EMAIL.test(TO)) {
  console.error('ALERT_EMAIL is not a usable address, so nothing was sent.');
  console.error(`shape: ${JSON.stringify(shapeOf(TO))}`);
  console.error('Fix it, then re-run. Setting it in the GitHub web UI avoids');
  console.error('the shell quoting that usually causes this.');
  process.exit(1);
}

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ from: FROM, to: [TO], subject, text: body }),
});

if (!res.ok) {
  /*
   * Say WHY.
   *
   * The first version printed only the status. A real 422 then told whoever was
   * debugging precisely nothing, which is a poor showing for the one script
   * whose entire job is to explain that something is wrong.
   *
   * The provider's validation message describes the request, not the
   * credential, so it is safe to print. Only that field is taken, never the
   * whole response, and the key is never echoed.
   */
  let why = '';
  try {
    const err = await res.json();
    why = err?.message ?? err?.error?.message ?? err?.name ?? '';
  } catch { /* not JSON; the status is all there is */ }
  console.error(`Alert send failed: HTTP ${res.status}${why ? ` — ${why}` : ''}`);
  if (res.status === 422) {
    /*
     * Describe the shape of ALERT_EMAIL, never its value.
     *
     * These logs are public — the repository is — so the address itself must
     * not appear. But "invalid to field" with nothing else sent us round twice
     * guessing whether the problem was a stray newline, a display name, or a
     * value that had never been set at all. Length and a few booleans settle
     * that in one run and disclose nothing.
     */
    const shape = {
      length: TO.length,
      hasAt: TO.includes('@'),
      hasDot: TO.split('@').pop()?.includes('.') ?? false,
      hasWhitespace: /\s/.test(TO),
      hasQuotes: /["']/.test(TO),
      hasAngles: /[<>]/.test(TO),
      startsAlnum: /^[A-Za-z0-9]/.test(TO),
    };
    console.error(`ALERT_EMAIL shape: ${JSON.stringify(shape)}`);
    console.error('It must be a bare address — no quotes, no display name, no');
    console.error('trailing newline. Set it with printf, which adds none:');
    console.error("  printf '%s' 'you@example.com' | gh secret set ALERT_EMAIL --repo <owner>/<repo>");
  }
  process.exit(1);
}
console.log(`Alert sent: ${subject}`);
