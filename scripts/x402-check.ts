// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Preflight for x402 configuration.
 *
 * Asks the configured facilitator what it will actually settle and checks that
 * our network is on the list. Worth running before enabling x402, because the
 * failure mode otherwise is silent: we advertise a price in a 402, an agent
 * signs an authorization, and the facilitator refuses it as an unsupported
 * network — after the agent has already done the work of paying.
 *
 * Note for anyone enabling this: at the time of writing, no PUBLIC facilitator
 * settles Base mainnet. x402.org supports exactly one EVM network,
 * eip155:84532 (Base Sepolia). Mainnet needs credentialed access such as
 * Coinbase CDP.
 */
import 'dotenv/config';
import { config } from '../src/lib/config.js';
import { x402Enabled, paymentRequired } from '../src/domain/x402.js';

if (!x402Enabled()) {
  console.log('  x402 is disabled (no facilitator or payee configured). Nothing to check.');
  process.exit(0);
}

const base = config.x402.facilitatorUrl.replace(/\/+$/, '');
const want = config.x402.network;

const res = await fetch(`${base}/supported`, { signal: AbortSignal.timeout(20_000) });
if (!res.ok) {
  console.error(`  facilitator ${base}/supported returned ${res.status}`);
  process.exit(1);
}
const { kinds } = await res.json() as { kinds: Array<{ scheme: string; network: string }> };

const exact = kinds.filter((k) => k.scheme === 'exact').map((k) => k.network);
const ok = exact.includes(want);

console.log(`  facilitator : ${base}`);
console.log(`  configured  : ${want}  (asset ${config.x402.asset})`);
console.log(`  settles     : ${exact.join(', ')}`);
console.log();
console.log(ok
  ? '  OK — the configured network is settleable by this facilitator.'
  : `  FAIL — this facilitator will NOT settle ${want}. An agent that pays will be refused.`);

if (ok) {
  const r = paymentRequired(`${config.publicUrl}/v1/effects/begin`).accepts[0]!;
  const missing = ['name', 'version'].filter((k) => !r.extra?.[k]);
  if (missing.length) {
    console.log(`  WARNING — extra is missing ${missing.join(', ')}; the EIP-712 domain is`);
    console.log('            required to reconstruct the signature and payments will fail.');
  }
}
process.exit(ok ? 0 : 1);
