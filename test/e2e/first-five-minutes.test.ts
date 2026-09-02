/**
 * The path from "signed up" to "gated an effect", and the ways it goes wrong.
 *
 * These are not feature tests. Every one of them is a moment where a new
 * integration stalls, and the assertion is that the service says enough for the
 * person to keep going without leaving the response they are looking at.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_OVERRIDE = '100000';

const { setupDb, closePool, getPool } = await import('../helpers.js');
const { buildApp } = await import('../../src/api/app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await setupDb(); app = await buildApp({ logger: false }); await app.ready(); });
after(async () => { await app.close(); await closePool(); });

const signup = async () => JSON.parse((await app.inject({
  method: 'POST', url: '/v1/workspaces',
  headers: { 'content-type': 'application/json' },
  payload: { name: 'ff', email: `ff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test` },
})).payload);

const begin = (key: string, body: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/v1/effects/begin',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  payload: body,
});

describe('signing up hands back something runnable', () => {
  test('the response carries the next request, not just credentials', async () => {
    const ws = await signup();
    assert.ok(ws.next_step, 'signup returns keys and no instruction');
    assert.match(ws.next_step.curl, /\/v1\/effects\/begin/);
    assert.ok(ws.next_step.curl.includes(ws.agent_api_key),
      'the command should carry the key just issued, so it runs as pasted');
  });

  test('the command is one line — a continued one arrives broken', async () => {
    const ws = await signup();
    assert.equal(ws.next_step.curl.includes('\n'), false);
    assert.equal(ws.next_step.curl.includes('\\'), false);
  });

  /**
   * The mistake every new integration makes. It is free until a lease expires,
   * at which point the next attempt is refused for reasons that look like a bug
   * in us.
   */
  test('it warns about the follow-up call people forget', async () => {
    const ws = await signup();
    assert.match(ws.next_step.then, /report/i);
    assert.match(ws.next_step.then, /indeterminate/i);
  });

  test('the command it gives actually works', async () => {
    const ws = await signup();
    // Run the same request the curl describes, through the same API.
    const r = await begin(ws.agent_api_key, {
      effect_type: 'email.send', idempotency_key: 'welcome:user_1',
      payload: { to: 'someone@example.com' },
    });
    assert.equal(r.statusCode, 200, r.payload.slice(0, 200));
    assert.equal(JSON.parse(r.payload).decision, 'execute');
  });

  test('the agent key it tells you to use cannot change policy', async () => {
    const ws = await signup();
    const r = await app.inject({
      method: 'PUT', url: '/v1/policies/email.send',
      headers: { authorization: `Bearer ${ws.agent_api_key}`, 'content-type': 'application/json' },
      payload: { mode: 'allow' },
    });
    assert.ok(r.statusCode === 403 || r.statusCode === 401,
      'the key handed to an agent must not be able to rewrite its own rules');
  });
});

describe('when it goes wrong, the response says how to get out', () => {
  /**
   * Being blocked is where a new integration dies. The response must name the
   * likely cause and the exact call that clears it.
   */
  test('a blocked effect names the endpoint that resolves it, with its own id', async () => {
    const ws = await signup();
    const key = ws.agent_api_key;
    const idem = `stuck-${Date.now()}`;

    const first = JSON.parse((await begin(key, {
      effect_type: 'email.send', idempotency_key: idem, payload: {} })).payload);
    assert.equal(first.decision, 'execute');

    // Exactly what happens when a caller acts and never reports: the lease runs out.
    await getPool().query(
      `UPDATE effects SET state='indeterminate', lease_expires_at = now() - interval '1 minute'
        WHERE id = $1`, [first.effect_id]);

    const blocked = JSON.parse((await begin(key, {
      effect_type: 'email.send', idempotency_key: idem, payload: {} })).payload);
    assert.equal(blocked.decision, 'blocked');

    assert.match(blocked.reason, /\/v1\/effects\/[a-zA-Z0-9_]+\/resolve/,
      'the way out must be a path the caller can use, not a description of one');
    assert.ok(blocked.reason.includes(first.effect_id),
      'resolve is addressed by id, so the reason must carry this effect\'s own id');
    assert.match(blocked.reason, /never reported/i,
      'it should name the usual cause, which is a missing report call');
  });

  test('the endpoint the blocked message names actually exists and works', async () => {
    const ws = await signup();
    const key = ws.agent_api_key;
    const op = ws.api_key;
    const idem = `resolvable-${Date.now()}`;

    const first = JSON.parse((await begin(key, {
      effect_type: 'email.send', idempotency_key: idem, payload: {} })).payload);
    await getPool().query(
      `UPDATE effects SET state='indeterminate', lease_expires_at = now() - interval '1 minute'
        WHERE id = $1`, [first.effect_id]);

    // Follow the instruction the blocked reason gives, literally.
    const resolved = await app.inject({
      method: 'POST', url: `/v1/effects/${first.effect_id}/resolve`,
      headers: { authorization: `Bearer ${op}`, 'content-type': 'application/json' },
      payload: { outcome: 'succeeded', evidence: 'checked the provider dashboard' },
    });
    assert.equal(resolved.statusCode, 200, resolved.payload.slice(0, 200));
  });

  test('a mistyped field is refused by name, not by a generic error', async () => {
    const ws = await signup();
    const r = await begin(ws.agent_api_key, {
      effect_type: 'email.send', key: 'wrong-field-name', payload: {} });
    assert.equal(r.statusCode, 400);
    assert.match(JSON.parse(r.payload).error.message, /idempotency_key/,
      'the error should name the field that is missing');
  });
});

describe('the mistake is named while it is still happening', () => {
  const beginN = async (key: string, n: number, tag: string) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push(JSON.parse((await begin(key, {
        effect_type: 'email.send', idempotency_key: `${tag}:${i}`, payload: { i },
      })).payload));
    }
    return out;
  };

  test('a couple of unreported effects is not worth a warning', async () => {
    const ws = await signup();
    const r = await beginN(ws.agent_api_key, 3, `quiet-${Date.now()}`);
    assert.equal(r[0].integration_warning, undefined);
    assert.equal(r[2].integration_warning, undefined,
      'someone testing carefully should not be scolded for it');
  });

  test('the fourth unreported begin says what is going wrong', async () => {
    const ws = await signup();
    const r = await beginN(ws.agent_api_key, 4, `loud-${Date.now()}`);
    const w = r[3].integration_warning;
    assert.ok(w, 'four effects begun, none reported, and nothing said');
    assert.match(w, /\/v1\/effects\/\{effect_id\}\/report/,
      'it must name the call that is missing, at the address it actually has');
    assert.match(w, /indeterminate/, 'and what happens if it stays missing');
    assert.match(w, /blocked/, 'and the failure it turns into later');
  });

  test('one report turns it off, and it stays off', async () => {
    const ws = await signup();
    const key = ws.agent_api_key;
    const tag = `fixed-${Date.now()}`;
    const first = await beginN(key, 4, tag);
    assert.ok(first[3].integration_warning, 'precondition: it was warning');

    const reported = await app.inject({
      method: 'POST', url: `/v1/effects/${first[0].effect_id}/report`,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: { lease_token: first[0].lease_token, outcome: 'succeeded' },
    });
    assert.equal(reported.statusCode, 200, reported.payload.slice(0, 200));

    // Three effects are still unreported. The workspace has reported once, and
    // that is the whole signal: this integration is wired up.
    const after = await beginN(key, 1, `${tag}-post`);
    assert.equal(after[0].integration_warning, undefined,
      'a workspace that reports must never be nagged about its backlog');
  });

  test('expired leases still count — the evidence outlives the lease', async () => {
    const ws = await signup();
    const key = ws.agent_api_key;
    const tag = `expired-${Date.now()}`;
    const begun = await beginN(key, 3, tag);
    await getPool().query(
      `UPDATE effects SET state='indeterminate', lease_token=NULL,
              lease_expires_at = now() - interval '1 minute'
        WHERE id = ANY($1)`, [begun.map((b) => b.effect_id)]);

    const next = await beginN(key, 1, `${tag}-after`);
    assert.ok(next[0].integration_warning,
      'reaping the leases must not erase the reason the workspace is in trouble');
  });

  test('a replayed duplicate is not a new mistake', async () => {
    const ws = await signup();
    const key = ws.agent_api_key;
    const tag = `dup-${Date.now()}`;
    await beginN(key, 4, tag);
    // Same key again: the duplicate path never takes the workspace lock, so it
    // cannot have computed a count, and must not invent one.
    const again = JSON.parse((await begin(key, {
      effect_type: 'email.send', idempotency_key: `${tag}:0`, payload: { i: 0 },
    })).payload);
    assert.equal(again.integration_warning, undefined);
  });
});

/**
 * Guidance that names an endpoint is a promise. Every one of these messages has
 * already been written wrong once — `resolve` and `report` are both addressed by
 * effect id, while `begin` is addressed by effect_type and idempotency_key, and
 * copying the shape of one into the other sends an already-stuck caller to a 404.
 * This walks whatever the service actually says today and knocks on every door.
 */
describe('every path our own guidance names is a real one', () => {
  const paths = (text: string) =>
    [...text.matchAll(/\/v1\/[A-Za-z0-9_{}/-]*[A-Za-z0-9_}]/g)].map((m) => m[0]);

  test('signup, blocked and the unreported warning all point somewhere real', async () => {
    const ws = await signup();
    const key = ws.agent_api_key;
    const tag = `paths-${Date.now()}`;

    const said: string[] = [ws.next_step.curl, ws.next_step.then, ws.next_step.expect];

    // Four unreported begins: the last carries the integration warning.
    let last: Record<string, string> = {};
    for (let i = 0; i < 4; i += 1) {
      last = JSON.parse((await begin(key, {
        effect_type: 'email.send', idempotency_key: `${tag}:${i}`, payload: {} })).payload);
    }
    assert.ok(last.integration_warning);
    said.push(last.integration_warning);

    await getPool().query(
      `UPDATE effects SET state='indeterminate', lease_expires_at = now() - interval '1 minute'
        WHERE workspace_id=$1`, [ws.workspace_id]);
    const blocked = JSON.parse((await begin(key, {
      effect_type: 'email.send', idempotency_key: `${tag}:0`, payload: {} })).payload);
    assert.equal(blocked.decision, 'blocked');
    said.push(blocked.reason);

    const found = [...new Set(said.flatMap(paths))];
    assert.ok(found.length >= 3, `expected several paths, saw ${JSON.stringify(found)}`);

    for (const path of found) {
      // A named placeholder stands for a value the caller already holds.
      const url = path.replace('{effect_id}', blocked.effect_id);
      assert.equal(url.includes('{'), false, `unresolved placeholder in ${path}`);
      const r = await app.inject({
        method: 'POST', url,
        headers: { authorization: `Bearer ${ws.api_key}`, 'content-type': 'application/json' },
        payload: {},
      });
      // 400 means the route exists and disliked the empty body — which is the
      // point. 404 means we sent a stuck person somewhere that does not exist.
      assert.notEqual(r.statusCode, 404, `${url} is named in our guidance and does not exist`);
    }
  });
});
