// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, no i/l/o/u

/** URL-safe, sortable-enough identifier with a type prefix. */
export function newId(prefix: string, bytes = 16): string {
  const buf = randomBytes(bytes);
  let out = '';
  for (const b of buf) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Normalise text to Unicode NFC.
 *
 * The same visible string has several legal encodings: "café" is one code point
 * on most systems and two on macOS, which yields NFD. Without this, an agent on
 * a Mac and one on Linux gating the SAME action produce different keys, both
 * are told to execute, and the customer is charged twice — precisely the
 * duplicate this service exists to prevent.
 *
 * NFC is the form W3C and Unicode Annex #15 recommend for identifiers. It
 * merges only sequences that are canonically equivalent, so two strings it
 * unifies were always the same string; nothing distinct is collapsed.
 *
 * The ASCII fast path matters: the overwhelming majority of keys are ASCII,
 * where normalisation is a no-op, and this keeps it off the hot path entirely.
 */
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;
export function normalizeText(v: string): string {
  return NON_ASCII.test(v) ? v.normalize('NFC') : v;
}

/**
 * Deterministic fingerprint of a JSON value: object keys are sorted so that
 * semantically identical payloads produce identical digests, and text is
 * normalised so that identical text does too.
 */
export function canonicalFingerprint(value: unknown): Buffer {
  return sha256(canonicalize(value));
}

export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return JSON.stringify(value);
  // Normalise before hashing, so the same text encoded two legal ways produces
  // one fingerprint rather than a false idempotency_key_reuse.
  if (typeof value === 'string') return JSON.stringify(normalizeText(value));
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    // Keys are normalised too — an object key is text like any other.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [normalizeText(k), v] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  return 'null';
}
