// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/**
 * Create a bucket.
 *
 * Named lowercase on purpose: S3 bucket names must be valid DNS labels, so a
 * capitalised name works only with path-style addressing and breaks the moment
 * anything reaches for virtual-host style.
 *
 *   node scripts/s3-mkbucket.mjs ratchet-backups
 */
import { createHash, createHmac } from 'node:crypto';

const BUCKET = process.argv[2];
if (!BUCKET) { console.error('usage: s3-mkbucket.mjs <bucket>'); process.exit(2); }
if (BUCKET !== BUCKET.toLowerCase()) {
  console.error('  bucket names must be lowercase to be a valid DNS label'); process.exit(2);
}

const ACCESS = process.env.TIGRIS_ACCESS_KEY_ID;
const SECRET = process.env.TIGRIS_SECRET_ACCESS_KEY;
const ENDPOINT = process.env.TIGRIS_ENDPOINT ?? 'https://fly.storage.tigris.dev';
const REGION = process.env.TIGRIS_REGION ?? 'auto';
if (!ACCESS || !SECRET) { console.error('  credentials not set'); process.exit(2); }

const host = new URL(ENDPOINT).host;
const sha256 = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();

const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
const dateStamp = amzDate.slice(0, 8);
const payloadHash = sha256('');
const uri = `/${BUCKET}`;

const canonicalHeaders =
  `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
const canonicalRequest =
  ['PUT', uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, dateStamp), REGION), 's3'), 'aws4_request');
const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

const res = await fetch(`${ENDPOINT}${uri}`, {
  method: 'PUT',
  headers: {
    host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  },
  signal: AbortSignal.timeout(30_000),
});

const body = await res.text();
if (res.ok || res.status === 409) {
  console.log(`  bucket ${BUCKET} ${res.status === 409 ? 'already exists' : 'created'}`);
} else {
  console.error(`  HTTP ${res.status}: ${body.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? body.slice(0, 200)}`);
  process.exit(1);
}
