/**
 * Rotating AUTH_SECRET.
 *
 * The secret that peppers every API key hash carried no record of WHICH secret,
 * so rotating it invalidated every key in existence at the same instant. That
 * made the one action an operator must take after a suspected compromise the
 * one action nobody could take — RECOVERY.md said as much: "Last resort".
 *
 * Two failure modes, and the second is the dangerous one. Keys dying is loud:
 * everything stops and you know within a minute. Dimensions re-blinding is
 * silent: every counterparty looks new, so a ceiling an operator believes is
 * holding refuses nothing until spend re-accumulates, while the console still
 * shows it configured. A security control failing OPEN, during the incident
 * response that prompted the rotation.
 *
 * These run in CHILD PROCESSES on purpose. A rotation is a restart with new
 * environment variables, and config resolves once at module load; re-importing
 * inside one process binds the new module to the old cached config and every
 * assertion passes without testing anything. The first version of this file did
 * exactly that.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const { setupDb, closePool, getPool } = await import('../helpers.js');

const A = 'rotation-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'rotation-secret-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const C = 'rotation-secret-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

/** Run a snippet in a fresh process under the given secrets, and read back JSON. */
function underSecrets(
  env: { current: string; retired?: string[]; dimension?: string },
  body: string,
): any {
  // No top-level await: tsx -e compiles to CJS, which does not allow it.
  const script = `
    (async () => { ${body} })().then(
      (out) => process.stdout.write('<<<' + JSON.stringify(out) + '>>>'),
      (e) => { console.error(String((e && e.stack) || e)); process.exit(1); },
    );
  `;
  const stdout = execFileSync('npx', ['tsx', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      AUTH_SECRET: env.current,
      AUTH_SECRET_RETIRED: (env.retired ?? []).join(','),
      ...(env.dimension ? { DIMENSION_SECRET: env.dimension } : { DIMENSION_SECRET: '' }),
    },
    timeout: 60_000,
  });
  const m = /<<<([\s\S]*)>>>/.exec(stdout);
  assert.ok(m, `child produced no result:\n${stdout}`);
  return JSON.parse(m[1]!);
}

const MAKE_KEY = `
  const { createWorkspace } = await import('./src/domain/auth.js');
  const ws = await createWorkspace('rot', 'rot-' + Date.now() + Math.random() + '@example.test');
  const { closePool } = await import('./src/db/pool.js');
  await closePool();
  return { workspaceId: ws.workspaceId, keyId: ws.key.id, token: ws.key.plaintext };
`;

const tryAuth = (token: string) => `
  const { authenticate } = await import('./src/domain/auth.js');
  const { closePool } = await import('./src/db/pool.js');
  let r;
  try { const ctx = await authenticate(${JSON.stringify(token)});
        r = { ok: true, workspaceId: ctx.workspaceId }; }
  catch (e) { r = { ok: false, status: e.status ?? null }; }
  // The re-hash is deliberately out of band; let it land before the pool closes.
  await new Promise((res) => setTimeout(res, 250));
  await closePool();
  return r;
`;

before(async () => { await setupDb(); });
after(async () => { await closePool(); });

describe('a key issued before the rotation still works after it', () => {
  test('it authenticates against the retired secret', () => {
    const made = underSecrets({ current: A }, MAKE_KEY);
    const got = underSecrets({ current: B, retired: [A], dimension: A }, tryAuth(made.token));
    assert.equal(got.ok, true,
      'every customer key dying at once is what made rotation impossible');
    assert.equal(got.workspaceId, made.workspaceId);
  });

  test('and using it drains the key onto the current secret', async () => {
    const made = underSecrets({ current: A }, MAKE_KEY);
    const kidOfB = underSecrets({ current: B }, `
      const { kidFor } = await import('./src/domain/auth.js');
      return kidFor(${JSON.stringify(B)});
    `);
    underSecrets({ current: B, retired: [A], dimension: A }, tryAuth(made.token));

    const { rows } = await getPool().query<{ secret_kid: string | null }>(
      'SELECT secret_kid FROM api_keys WHERE id = $1', [made.keyId]);
    assert.equal(rows[0]!.secret_kid, kidOfB,
      'a rotation nobody can finish is one the old secret is kept for for ever');
  });

  test('once drained, the retired secret can be dropped', () => {
    const made = underSecrets({ current: A }, MAKE_KEY);
    underSecrets({ current: B, retired: [A], dimension: A }, tryAuth(made.token));
    const after = underSecrets({ current: B, retired: [], dimension: A }, tryAuth(made.token));
    assert.equal(after.ok, true, 'which is the whole point of draining');
  });

  test('a key from a secret nobody configured is refused', () => {
    const made = underSecrets({ current: A }, MAKE_KEY);
    const got = underSecrets({ current: C, retired: [B], dimension: A }, tryAuth(made.token));
    assert.equal(got.ok, false, 'accepting it would mean the pepper did nothing');
    assert.equal(got.status, 401);
  });

  test('a revoked key stays revoked across a rotation', async () => {
    const made = underSecrets({ current: A }, MAKE_KEY);
    await getPool().query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [made.keyId]);
    const got = underSecrets({ current: B, retired: [A], dimension: A }, tryAuth(made.token));
    assert.equal(got.ok, false);
    assert.equal(got.status, 401);
  });
});

describe('the silent half: ceilings must keep counting', () => {
  const blindIt = `
    const { blind } = await import('./src/lib/dimensions.js');
    return blind('ws_fixed', { counterparty: 'acct_1234' }).counterparty;
  `;

  test('a counterparty blinded before the rotation is the same one after', () => {
    const was = underSecrets({ current: A }, blindIt);
    const now = underSecrets({ current: B, retired: [A], dimension: A }, blindIt);
    assert.equal(now, was,
      'a re-blinded destination looks new, so the ceiling stops refusing and '
      + 'nothing anywhere reports a problem');
  });

  test('and would not be, had the pepper not been pinned', () => {
    // The failure demonstrated, not merely asserted about — otherwise the
    // production check below is theatre guarding nothing.
    const was = underSecrets({ current: A }, blindIt);
    const careless = underSecrets({ current: B, retired: [A] }, blindIt);
    assert.notEqual(careless, was);
  });

  test('production refuses to start in exactly that configuration', () => {
    const problems = underSecrets({ current: B, retired: [A] }, `
      process.env.NODE_ENV = 'production';
      const { assertProductionSafety } = await import('./src/lib/config.js');
      return assertProductionSafety();
    `);
    assert.ok(problems.some((p: string) => /DIMENSION_SECRET/.test(p)),
      'the trap is silent, so before boot is the only place to catch it');
  });

  test('pinning the pepper satisfies it', () => {
    const problems = underSecrets({ current: B, retired: [A], dimension: A }, `
      process.env.NODE_ENV = 'production';
      const { assertProductionSafety } = await import('./src/lib/config.js');
      return assertProductionSafety();
    `);
    assert.equal(problems.some((p: string) => /DIMENSION_SECRET/.test(p)), false);
  });

  test('a retired secret that is really the current one is refused', () => {
    const problems = underSecrets({ current: B, retired: [B], dimension: A }, `
      process.env.NODE_ENV = 'production';
      const { assertProductionSafety } = await import('./src/lib/config.js');
      return assertProductionSafety();
    `);
    assert.ok(problems.some((p: string) => /nothing has actually been rotated/.test(p)));
  });
});

describe('the two-phase procedure the runbook prescribes', () => {
  /**
   * Instances roll one at a time, so mid-deploy some run the old configuration
   * and some the new. Swapping in a single deploy opens a real outage window: a
   * new instance authenticates a key, drains it onto the new secret, and the
   * next request routed to an old instance — which has never heard of that
   * secret — 401s a perfectly valid key.
   *
   * The two phases remove the window because in BOTH of them every instance
   * accepts both secrets. That is the claim RECOVERY.md now rests on, so it is
   * tested rather than reasoned about.
   */
  const phase1 = { current: A, retired: [B], dimension: A };   // teach, do not adopt
  const phase2 = { current: B, retired: [A], dimension: A };   // adopt

  test('a phase-1 instance accepts a key drained by a phase-2 instance', () => {
    const made = underSecrets({ current: A }, MAKE_KEY);
    // A phase-2 instance sees it first and drains it onto B.
    assert.equal(underSecrets(phase2, tryAuth(made.token)).ok, true);
    // A straggler still on phase 1 must still accept it.
    assert.equal(underSecrets(phase1, tryAuth(made.token)).ok, true,
      'this is the outage a single-deploy swap would cause');
  });

  test('a phase-2 instance accepts a key a phase-1 instance has seen', () => {
    const made = underSecrets({ current: A }, MAKE_KEY);
    assert.equal(underSecrets(phase1, tryAuth(made.token)).ok, true);
    assert.equal(underSecrets(phase2, tryAuth(made.token)).ok, true);
  });

  test('phase 1 does not drain anything, so it is safe to sit in', async () => {
    const made = underSecrets({ current: A }, MAKE_KEY);
    const kidOfA = underSecrets({ current: A }, `
      const { kidFor } = await import('./src/domain/auth.js');
      return kidFor(${JSON.stringify(A)});
    `);
    underSecrets(phase1, tryAuth(made.token));
    const { rows } = await getPool().query<{ secret_kid: string | null }>(
      'SELECT secret_kid FROM api_keys WHERE id = $1', [made.keyId]);
    assert.equal(rows[0]!.secret_kid, kidOfA,
      'phase 1 must not start moving keys onto a secret that is not current yet');
  });
});

describe('what a rotation deliberately does NOT carry across', () => {
  test('console sessions end, and the runbook says so', () => {
    // Session ids are sha256(raw + AUTH_SECRET) with no version, so every
    // operator signs in again. That is a real cost and it is documented rather
    // than fixed: it affects operators, not agents, and ending every session is
    // a reasonable thing to happen at the moment you rotate a compromised
    // secret. If this ever becomes survivable, the runbook has to change too.
    const made = underSecrets({ current: A }, `
      const { createWorkspace, createConsoleSession } = await import('./src/domain/auth.js');
      const { closePool } = await import('./src/db/pool.js');
      const ws = await createWorkspace('sess', 'sess-' + Date.now() + Math.random() + '@example.test');
      const raw = await createConsoleSession(ws.workspaceId, 'sess@example.test');
      await closePool();
      return { raw };
    `);
    const after = underSecrets({ current: B, retired: [A], dimension: A }, `
      const { resolveConsoleSession } = await import('./src/domain/auth.js');
      const { closePool } = await import('./src/db/pool.js');
      const s = await resolveConsoleSession(${'${JSON.stringify(made.raw)}'});
      await closePool();
      return { resolved: s !== null };
    `.replace('${JSON.stringify(made.raw)}', JSON.stringify(made.raw)));
    assert.equal(after.resolved, false,
      'RECOVERY.md promises operators will sign in again; if that stops being '
      + 'true the runbook is wrong');
  });
});

describe('knowing when the rotation is done', () => {
  test('live keys are reported per secret, so the old one can be dropped', () => {
    const made = underSecrets({ current: A }, MAKE_KEY);
    const drain = underSecrets({ current: B, retired: [A], dimension: A }, `
      const { pepperDrain, kidFor, createApiKey } = await import('./src/domain/auth.js');
      const { getPool, closePool } = await import('./src/db/pool.js');
      await createApiKey(getPool(), ${JSON.stringify(made.workspaceId)}, 'drain-new');
      const d = await pepperDrain();
      await closePool();
      return { ...d, kidA: kidFor(${JSON.stringify(A)}), kidB: kidFor(${JSON.stringify(B)}) };
    `);
    const onOld = drain.live.find((r: any) => r.kid === drain.kidA);
    const onNew = drain.live.find((r: any) => r.kid === drain.kidB);
    assert.equal(drain.currentKid, drain.kidB);
    assert.ok(onOld && onOld.keys >= 1, 'the retired secret is still load-bearing');
    assert.ok(onNew && onNew.keys >= 1);
    assert.equal(onOld.current, false);
    assert.equal(onOld.known, true, 'still configured, so those keys still work');
  });

  test('keys on a secret that was dropped too early are flagged, not hidden', () => {
    underSecrets({ current: A }, MAKE_KEY);
    const drain = underSecrets({ current: C, retired: [], dimension: A }, `
      const { pepperDrain, kidFor } = await import('./src/domain/auth.js');
      const { closePool } = await import('./src/db/pool.js');
      const d = await pepperDrain();
      await closePool();
      return { ...d, kidA: kidFor(${JSON.stringify(A)}) };
    `);
    const orphan = drain.live.find((r: any) => r.kid === drain.kidA);
    assert.ok(orphan, 'the rows are still there');
    assert.equal(orphan.known, false,
      'those keys cannot authenticate any more, and an operator should see that '
      + 'here rather than learn it from a support ticket');
  });
});
