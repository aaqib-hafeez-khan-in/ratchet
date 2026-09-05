#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Did the live card payment actually land?
 *
 * Run before and after a real purchase. The interesting question is not
 * "did Stripe say ok" — Stripe's dashboard answers that. It is whether the
 * money became credit in OUR ledger, exactly once, with a balance that agrees
 * with the entries that produced it.
 *
 * A payment that charges the customer and does not credit them is the worst
 * outcome this codebase can produce, and it is invisible from the Stripe side.
 *
 *   node scripts/verify-live-payment.mjs baseline   # before
 *   node scripts/verify-live-payment.mjs check      # after
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const MODE = process.argv[2] ?? 'check';
const SNAP = '/tmp/ratchet-payment-baseline.json';

const SQL = `
SELECT json_build_object(
  'topups', (SELECT count(*) FROM ledger_entries WHERE kind = 'topup'),
  'topup_micros', (SELECT COALESCE(sum(delta_micros),0) FROM ledger_entries WHERE kind = 'topup'),
  'latest', (
    SELECT json_agg(row_to_json(t)) FROM (
      SELECT workspace_id, delta_micros, balance_after, dedupe_key,
             detail->>'provider' AS provider, created_at
        FROM ledger_entries WHERE kind = 'topup'
        ORDER BY created_at DESC LIMIT 3) t),
  'balance_agrees', (
    /* Every workspace's credit_micros must equal the sum of its ledger deltas.
       If a payment credited the balance without a row, or a row without the
       balance, this is where it shows. Block comments, not line comments: the
       query is flattened to one line before it is sent, and a -- would swallow
       everything after it. */
    SELECT count(*) FROM workspaces w
     WHERE w.credit_micros <> COALESCE(
       (SELECT sum(delta_micros) FROM ledger_entries l WHERE l.workspace_id = w.id), 0))
)::text`;

function query() {
  const raw = execFileSync('flyctl', [
    'ssh', 'console', '-a', 'ratchet-gate-pg', '--machine', process.env.PG_MACHINE || 'd8d204df245618',
    '-C', `psql -U postgres -p 5433 -d ratchet_gate -tAc "${SQL.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const line = raw.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error('no JSON in psql output — is the machine id right?');
  return JSON.parse(line);
}

const usd = (m) => `$${(Number(m) / 1e6).toFixed(2)}`;
const now = query();

if (MODE === 'baseline') {
  writeFileSync(SNAP, JSON.stringify(now));
  console.log(`  baseline saved — ${now.topups} topups totalling ${usd(now.topup_micros)}`);
  console.log('  now make the purchase, then: node scripts/verify-live-payment.mjs check');
  process.exit(0);
}

console.log(`  topups now          ${now.topups} totalling ${usd(now.topup_micros)}`);
console.log(`  balance mismatches  ${now.balance_agrees}  ${now.balance_agrees === 0 ? '(every balance equals its ledger)' : '← INVESTIGATE'}`);

if (existsSync(SNAP)) {
  const before = JSON.parse(readFileSync(SNAP, 'utf8'));
  const dTopups = now.topups - before.topups;
  const dMicros = Number(now.topup_micros) - Number(before.topup_micros);
  console.log(`\n  since baseline:     +${dTopups} topup(s), ${usd(dMicros)}`);
  if (dTopups === 0) console.log('  → nothing credited yet. The webhook may not have arrived.');
  if (dTopups > 1) console.log('  → MORE THAN ONE topup. A double credit is the thing to rule out.');
}

console.log('\n  most recent topups:');
for (const t of now.latest ?? []) {
  console.log(`    ${usd(t.delta_micros)}  ws=${t.workspace_id}  via=${t.provider ?? '?'}  ${t.created_at}`);
}

if (now.balance_agrees !== 0) process.exit(1);
