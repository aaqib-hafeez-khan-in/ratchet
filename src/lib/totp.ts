// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP — RFC 6238, over HOTP — RFC 4226.
 *
 * Written out rather than pulled in, because the whole implementation is forty
 * lines and a dependency here would be a supply-chain risk sitting directly on
 * the authentication path. It is checked against the test vectors in RFC 6238
 * Appendix B, which is the only reason to believe it: a TOTP implementation
 * that is subtly wrong still produces six plausible digits, and you find out
 * when somebody cannot get into their account.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, which is what every authenticator app expects. */
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error(`not base32: ${JSON.stringify(c)}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret. 20 bytes is what RFC 4226 §4 R6 requires as a minimum. */
export function newSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export interface TotpOptions {
  /** Seconds per step. 30 is universal; every authenticator app assumes it. */
  step?: number;
  digits?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
  /** Unix epoch seconds. */
  t0?: number;
}

/** HOTP: the counter-based primitive TOTP is defined over. */
export function hotp(
  secret: Buffer, counter: number,
  { digits = 6, algorithm = 'sha1' }: Pick<TotpOptions, 'digits' | 'algorithm'> = {},
): string {
  const c = Buffer.alloc(8);
  // Counter is 64-bit big-endian. Written in two halves because a bitwise
  // shift in JS is 32-bit and would silently truncate above 2^31.
  c.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  c.writeUInt32BE(counter >>> 0, 4);

  const mac = createHmac(algorithm, secret).update(c).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24)
    | ((mac[offset + 1]! & 0xff) << 16)
    | ((mac[offset + 2]! & 0xff) << 8)
    | (mac[offset + 3]! & 0xff);

  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totp(secretB32: string, atMs: number = Date.now(), o: TotpOptions = {}): string {
  const { step = 30, t0 = 0 } = o;
  const counter = Math.floor((Math.floor(atMs / 1000) - t0) / step);
  return hotp(base32Decode(secretB32), counter, o);
}

/**
 * Verify a code, allowing a window of steps either side for clock drift.
 *
 * Constant-time comparison, and every candidate step is compared even after a
 * match, so the time taken does not reveal which step matched — that would leak
 * the client's clock offset, which is small but is not nothing.
 */
export function verifyTotp(
  secretB32: string, code: string,
  { window = 1, atMs = Date.now(), ...o }: TotpOptions & { window?: number; atMs?: number } = {},
): boolean {
  const digits = o.digits ?? 6;
  const given = code.replace(/\s+/g, '');
  if (!/^\d+$/.test(given) || given.length !== digits) return false;

  const g = Buffer.from(given, 'utf8');
  let ok = false;
  for (let i = -window; i <= window; i++) {
    const at = atMs + i * (o.step ?? 30) * 1000;
    const candidate = Buffer.from(totp(secretB32, at, o), 'utf8');
    if (candidate.length === g.length && timingSafeEqual(candidate, g)) ok = true;
  }
  return ok;
}

/** The URI an authenticator app scans. The secret never leaves this process
 *  except inside this string, which is shown once at enrolment. */
export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({
    secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30',
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
