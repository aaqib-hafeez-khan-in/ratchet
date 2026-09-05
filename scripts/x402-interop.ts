// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Wire-format interoperability check against a live x402 facilitator.
 *
 * Deliberately uses a signature that cannot be valid. The question is not
 * "does this payment settle" — no money moves here — but "does a real
 * facilitator PARSE what we emit". A reply about the signature means our
 * envelope was understood; a reply about missing parameters or an unsupported
 * scheme means it was not.
 */
import { paymentRequired } from '../src/domain/x402.js';

const FACILITATORS = [
  'https://x402.org/facilitator',
  'https://facilitator.x402.rs',
];

const requirements = paymentRequired('https://ratchetgate.com/v1/effects/begin').accepts[0]!;

const paymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: {
    signature: '0x' + 'ab'.repeat(65),
    authorization: {
      from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
      to: requirements.payTo,
      value: requirements.amount,
      validAfter: '1740672089',
      validBefore: String(Math.floor(Date.now() / 1000) + 600),
      nonce: '0x' + 'f3'.repeat(32),
    },
  },
};

const body = { x402Version: 2, paymentPayload, paymentRequirements: requirements };

for (const base of FACILITATORS) {
  try {
    const res = await fetch(`${base}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let j: Record<string, unknown> = {};
    try { j = JSON.parse(text); } catch { /* non-JSON */ }
    const reason = String(j.invalidReason ?? j.error ?? '');
    const understood = !['missing_parameters', 'unsupported_scheme', 'invalid_request']
      .includes(reason);
    console.log(`  ${base}`);
    console.log(`    status         : ${res.status}`);
    console.log(`    invalidReason  : ${reason || '(none)'}`);
    console.log(`    envelope parsed: ${understood ? 'YES' : 'NO'}`);
    if (!understood) console.log(`    detail         : ${text.slice(0, 200)}`);
    console.log();
  } catch (e) {
    console.log(`  ${base}\n    unreachable: ${(e as Error).message}\n`);
  }
}
