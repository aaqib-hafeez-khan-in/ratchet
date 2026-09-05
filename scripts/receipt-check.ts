// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/** Round-trip check for receipt signing, run outside the test harness. */
import 'dotenv/config';
import { RECEIPT_VERSION, signBody, verifyReceipt, receiptPublicKey } from '../src/domain/receipts.js';

const body = {
  v: RECEIPT_VERSION, workspace_id: 'ws_1', effect_id: 'eff_1',
  effect_type: 'payment.charge', idempotency_key: 'k', decision: 'execute',
  state: 'pending', attempt: 1, payload_fingerprint: 'abc',
  cost_micros: 0, kid: 'test-kid',
  decided_at: new Date().toISOString(),
};
const s = signBody(body);
console.log('  public key   :', receiptPublicKey().slice(0, 24) + '…');
console.log('  verifies     :', verifyReceipt(s.body, s.signature));
console.log('  tampered body:', verifyReceipt(s.body.replace('execute', 'blocked'), s.signature));
console.log('  wrong key    :', verifyReceipt(s.body, s.signature, Buffer.alloc(32).toString('base64')));
