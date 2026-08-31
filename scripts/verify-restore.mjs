/**
 * Verify a RESTORED database using only public information.
 *
 * Row counts matching proves the rows came across. It does not prove the
 * evidence is still evidence. This re-verifies every receipt signature and
 * every chain link in the restored copy, using the public key published by the
 * live service — no server secret, exactly what a customer auditing us would
 * have.
 *
 * If a dump/restore ever mangled a byte of a signed body, this is where it
 * shows up.
 *
 *   node scripts/verify-restore.mjs "postgres://…/restored" https://ratchetgate.com
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import pg from 'pg';

const [, , CONN, BASE = 'https://ratchetgate.com'] = process.argv;
if (!CONN) { console.error('usage: verify-restore.mjs <conn> [base]'); process.exit(2); }

const keyDoc = await (await fetch(`${BASE}/.well-known/ratchet-receipt-key`)).json();
const keys = new Map((keyDoc.keys ?? []).map((k) => [k.kid, k.public_key]));
if (keyDoc.public_key) keys.set(keyDoc.current_kid, keyDoc.public_key);
console.log(`  published keys: ${keys.size} (current ${keyDoc.current_kid})`);

function verifySig(bodyJson, sigB64, pubB64) {
  const raw = Buffer.from(pubB64 ?? '', 'base64');
  if (raw.length !== 32) return false;
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  try {
    return edVerify(null, Buffer.from(bodyJson),
      createPublicKey({ key: spki, format: 'der', type: 'spki' }),
      Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

const pool = new pg.Pool({ connectionString: CONN });
const { rows } = await pool.query(
  `SELECT workspace_id, seq, body, signature, body_hash, prev_hash, chain_hash, kid
     FROM receipts WHERE seq IS NOT NULL ORDER BY workspace_id, seq`);

const byWs = new Map();
for (const r of rows) {
  if (!byWs.has(r.workspace_id)) byWs.set(r.workspace_id, []);
  byWs.get(r.workspace_id).push(r);
}

let chains = 0, checked = 0, sigFail = 0, hashFail = 0, linkFail = 0, unknownKey = 0;
for (const [, list] of byWs) {
  chains++;
  let prev = null;
  for (const r of list) {
    checked++;
    if (createHash('sha256').update(r.body).digest('hex') !== r.body_hash) hashFail++;
    const kid = JSON.parse(r.body).kid;
    const pub = kid ? keys.get(kid) : keyDoc.public_key;
    if (kid && !pub) { unknownKey++; continue; }
    if (!verifySig(r.body, r.signature, pub)) sigFail++;
    if ((r.prev_hash ?? null) !== prev) linkFail++;
    const expect = createHash('sha256')
      .update(`${prev ?? ''}|${r.seq}|${r.body_hash}`).digest('hex');
    if (expect !== r.chain_hash) linkFail++;
    prev = r.chain_hash;
  }
}

console.log(`  chains        : ${chains}`);
console.log(`  receipts      : ${checked}`);
console.log(`  body hash bad : ${hashFail}`);
console.log(`  signature bad : ${sigFail}`);
console.log(`  chain link bad: ${linkFail}`);
console.log(`  unknown key   : ${unknownKey}`);
const ok = !hashFail && !sigFail && !linkFail && !unknownKey && checked > 0;
console.log(`\n  ${ok
  ? 'PASS — every receipt in the RESTORED copy still verifies against the published key.'
  : 'FAIL — the restored evidence does not verify.'}`);
await pool.end();
process.exit(ok ? 0 : 1);
