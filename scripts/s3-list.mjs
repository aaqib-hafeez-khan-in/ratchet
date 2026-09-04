// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * List buckets, or the objects in one, with SigV4.
 *
 * Exists because "the bucket name I was told" and "the bucket name that exists"
 * turned out to be different things, and guessing at it wastes a round trip
 * each time.
 *
 *   node scripts/s3-list.mjs            # buckets
 *   node scripts/s3-list.mjs <bucket>   # objects in a bucket
 */
import { createHash, createHmac } from 'node:crypto';

const BUCKET = process.argv[2] ?? '';
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
const uri = BUCKET ? `/${encodeURIComponent(BUCKET)}/` : '/';

const canonicalHeaders =
  `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
const canonicalRequest =
  ['GET', uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, dateStamp), REGION), 's3'), 'aws4_request');
const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

const res = await fetch(`${ENDPOINT}${uri}`, {
  headers: {
    host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${ACCESS}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  },
  signal: AbortSignal.timeout(30_000),
});
const body = await res.text();

if (!res.ok) {
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? res.status;
  console.error(`  HTTP ${res.status}: ${code}`);
  process.exit(1);
}

if (!BUCKET) {
  const names = [...body.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
  console.log(`  ${names.length} bucket(s):`);
  for (const n of names) console.log(`    ${n}`);
} else {
  const keys = [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  const sizes = [...body.matchAll(/<Size>(\d+)<\/Size>/g)].map((m) => Number(m[1]));
  console.log(`  ${keys.length} object(s) in ${BUCKET}:`);
  keys.forEach((k, i) => console.log(`    ${String(sizes[i] ?? '').padStart(10)}  ${k}`));
}
