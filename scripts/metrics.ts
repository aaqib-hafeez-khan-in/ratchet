// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * Operator metrics report. Prints the thresholds from
 * docs/handoff/PRICING_AND_DISTRIBUTION_REVIEW.md §6 with pass/fail against
 * their targets, so the decision to change pricing is evidence-driven.
 *
 *   npx tsx scripts/metrics.ts [--json] [--window 30]
 */
import { computeMetrics } from '../src/domain/metrics.js';
import { closePool } from '../src/db/pool.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const wIdx = args.indexOf('--window');
const windowDays = wIdx >= 0 ? Number(args[wIdx + 1]) : 30;

const m = await computeMetrics(windowDays);

if (asJson) {
  console.log(JSON.stringify(m, null, 2));
  await closePool();
  process.exit(0);
}

const pct = (v: number | null) => (v === null ? '  n/a' : `${(v * 100).toFixed(1)}%`);
const usd = (micros: number) => `$${(micros / 1e6).toFixed(2)}`;

/** A target is only meaningful once there is enough data to judge it. */
const MIN_SAMPLE = 20;
function verdict(value: number | null, target: number, higherIsBetter = true): string {
  if (value === null) return 'no data';
  if (m.sampleSize < MIN_SAMPLE) return 'sample too small';
  const pass = higherIsBetter ? value >= target : value <= target;
  return pass ? 'MET' : 'below target';
}

console.log(`\nRatchet operating metrics — ${m.generatedAt}`);
console.log(`Sample: ${m.sampleSize} workspace(s); ${m.workspaces.createdInWindow} created in the last ${windowDays} days`);
if (m.sampleSize < MIN_SAMPLE) {
  console.log(`\n  NOTE: fewer than ${MIN_SAMPLE} workspaces. Every rate below is noise, not signal.`);
  console.log('  Do not change pricing on the strength of these numbers.');
}

console.log('\n── Activation ──────────────────────────────────────────────');
console.log(`  reached first begin        ${m.activation.reachedFirstBegin}`);
console.log(`  activated (full workflow)  ${m.activation.activated}`);
console.log(`  activation rate            ${pct(m.activation.activationRate).padStart(6)}   target ≥40%   ${verdict(m.activation.activationRate, 0.40)}`);
console.log(`  time to first success      p50 ${m.activation.medianMinutesToFirstSuccess ?? 'n/a'} min, p90 ${m.activation.p90MinutesToFirstSuccess ?? 'n/a'} min   target p50 ≤15 min`);

console.log('\n── Usage ───────────────────────────────────────────────────');
console.log(`  active workspaces  7d/30d  ${m.usage.activeWorkspacesLast7Days} / ${m.usage.activeWorkspacesLast30Days}`);
console.log(`  repeat usage (days 7–14)   ${pct(m.usage.repeatUsageRate).padStart(6)}   target ≥50%   ${verdict(m.usage.repeatUsageRate, 0.50)}`);
console.log(`  effects begun (30d)        ${m.usage.effectsBegunLast30Days.toLocaleString()}`);
console.log(`  effects succeeded (30d)    ${m.usage.effectsSucceededLast30Days.toLocaleString()}`);
console.log(`  indeterminate rate         ${pct(m.usage.indeterminateRate).padStart(6)}   (the number worth alerting on)`);

console.log('\n── Retention ───────────────────────────────────────────────');
console.log(`  month 1                    ${pct(m.retention.month1).padStart(6)}`);
console.log(`  month 3                    ${pct(m.retention.month3).padStart(6)}   target ≥70%   ${verdict(m.retention.month3, 0.70)}`);

console.log('\n── Money ───────────────────────────────────────────────────');
console.log(`  paid workspaces            ${m.revenue.paidWorkspaces}`);
console.log(`  credit purchased           ${usd(m.revenue.creditPurchasedMicros)}`);
console.log(`  credit reversed            ${usd(m.revenue.creditReversedMicros)}  (refunds and disputes)`);
console.log(`  credit outstanding         ${usd(m.revenue.creditOutstandingMicros)}  (a liability, not revenue)`);
console.log(`  metered revenue recognised ${usd(m.revenue.meteredRevenueMicros)}`);

console.log('\nThese are operating targets, not market facts. See');
console.log('docs/handoff/PRICING_AND_DISTRIBUTION_REVIEW.md §6.\n');

await closePool();
