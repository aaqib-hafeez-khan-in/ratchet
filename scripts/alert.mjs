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

if (!['down', 'recovered', 'test'].includes(kind)) {
  console.error('usage: alert.mjs <down|recovered|test> "<summary>"');
  process.exit(2);
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
    console.error('A 422 here is almost always ALERT_EMAIL: it must be a bare');
    console.error('address, with no quotes, label or trailing newline.');
  }
  process.exit(1);
}
console.log(`Alert sent: ${subject}`);
