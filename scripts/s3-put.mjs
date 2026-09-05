// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Minimal S3 PUT with AWS SigV4, for shipping a verified backup off-machine.
 *
 * Written out rather than installing an SDK or the AWS CLI: this repo keeps
 * nine production dependencies on purpose, and a backup script that only runs
 * on a machine where someone remembered to `brew install awscli` is a backup
 * script that will not run when it matters.
 *
 *   node scripts/s3-put.mjs <file> <key>
 *
 * Reads TIGRIS_ACCESS_KEY_ID, TIGRIS_SECRET_ACCESS_KEY, TIGRIS_BUCKET,
 * TIGRIS_ENDPOINT from the environment. The secret is never logged.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [, , FILE, KEY_ARG] = process.argv;
if (!FILE) { console.error('usage: s3-put.mjs <file> [key]'); process.exit(2); }

const ACCESS = process.env.TIGRIS_ACCESS_KEY_ID;
const SECRET = process.env.TIGRIS_SECRET_ACCESS_KEY;
const BUCKET = process.env.TIGRIS_BUCKET;
const ENDPOINT = process.env.TIGRIS_ENDPOINT ?? 'https://fly.storage.tigris.dev';
const REGION = process.env.TIGRIS_REGION ?? 'auto';

for (const [n, v] of Object.entries({ TIGRIS_ACCESS_KEY_ID: ACCESS,
  TIGRIS_SECRET_ACCESS_KEY: SECRET, TIGRIS_BUCKET: BUCKET })) {
  if (!v) { console.error(`  ${n} is not set`); process.exit(2); }
}

const key = KEY_ARG ?? basename(FILE);
const body = readFileSync(FILE);
const host = new URL(ENDPOINT).host;

const sha256 = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();

const now = new Date();
const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260831T113000Z
const dateStamp = amzDate.slice(0, 8);
const payloadHash = sha256(body);

// Path-style addressing: Tigris accepts it, and it avoids bucket names that
// are not valid DNS labels — "Ratchet" has a capital letter, which a
// virtual-host style URL cannot express.
const canonicalUri = `/${encodeURIComponent(BUCKET)}/${key.split('/').map(encodeURIComponent).join('/')}`;

const canonicalHeaders =
  `host:${host}\n` +
  `x-amz-content-sha256:${payloadHash}\n` +
  `x-amz-date:${amzDate}\n`;
const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

const canonicalRequest = [
  'PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
].join('\n');

const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
const stringToSign = [
  'AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest),
].join('\n');

const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, dateStamp), REGION), 's3'), 'aws4_request');
const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

const authorization =
  `AWS4-HMAC-SHA256 Credential=${ACCESS}/${scope}, ` +
  `SignedHeaders=${signedHeaders}, Signature=${signature}`;

if (process.env.S3_DEBUG) {
  console.error('--- canonical request ---');
  console.error(JSON.stringify(canonicalRequest));
  console.error('--- string to sign ---');
  console.error(JSON.stringify(stringToSign));
  console.error('--- url ---');
  console.error(`${ENDPOINT}${canonicalUri}`);
}

const res = await fetch(`${ENDPOINT}${canonicalUri}`, {
  method: 'PUT',
  headers: {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization,
    'content-length': String(body.length),
  },
  body,
  signal: AbortSignal.timeout(120_000),
});

if (!res.ok) {
  const text = await res.text();
  console.error(`  upload failed: HTTP ${res.status}`);
  console.error(`  ${text.slice(0, 400)}`);
  process.exit(1);
}

console.log(`  uploaded ${body.length} bytes to ${BUCKET}/${key}`);
console.log(`  sha256: ${payloadHash}`);
