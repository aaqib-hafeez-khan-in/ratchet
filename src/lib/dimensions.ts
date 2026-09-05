// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { ApiError } from './errors.js';

/**
 * Declared dimensions: counting a thing without seeing it.
 *
 * Ratchet never stores the payload of a gated effect, and the destination of a
 * payment lives in the payload. That is why there was no way to say "no more
 * than $2,000 to any one counterparty per day" — the one ceiling a risk team
 * actually wants.
 *
 * Reading and counting are different problems. A caller declares a dimension
 * alongside the payload; only `HMAC(pepper, workspace|name|value)` is kept. The
 * value cannot be recovered from what is stored, and because the workspace id is
 * inside the MAC, the same account number in two workspaces produces two
 * unrelated identifiers — there is no cross-tenant correlation to leak even
 * accidentally.
 *
 * WHAT A DECLARATION CAN AND CANNOT DO. CLAUDE.md §6 says agent-supplied text
 * must never influence control flow, and a dimension is agent-supplied text that
 * selects a ceiling. The rule is preserved by making declarations strictly
 * additive: declaring a dimension can only ADD a limit, never remove one, and
 * the workspace, key and effect-type ceilings apply regardless. A caller that
 * omits a required dimension is refused, so omission is not an escape either. A
 * caller that lies about the value lands in a different bucket but gains nothing
 * it did not already have — and the vendor knows the real destination, so
 * `POST /v1/reconcile` is where a lie surfaces.
 */

/** Enough distinct axes to be useful; few enough that the scope list stays cheap. */
export const MAX_DIMENSIONS = 8;
const NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_VALUE = 256;

/** Blinded dimensions as stored: name -> 32 hex characters. */
export type Blinded = Record<string, string>;

/**
 * 128 bits of a peppered MAC.
 *
 * Truncated because this is a bucket identifier, not a signature: collisions
 * would merge two counterparties' counters, and 2^-64 for that is far beyond
 * what a ceiling needs. Without the pepper the input is unrecoverable; with it,
 * an attacker already holds AUTH_SECRET and has larger problems.
 */
function blindOne(workspaceId: string, name: string, value: string): string {
  // dimensionSecret, not authSecret. A blinded value cannot be re-derived — the
  // input is gone by design — so this pepper changing does not invalidate a
  // ceiling, it resets one. See the note on config.dimensionSecret.
  return createHmac('sha256', config.dimensionSecret)
    .update(`dim:v1:${workspaceId}:${name}:${value}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Validate and blind. Throws a 400 naming the offending dimension — this is a
 * caller mistake, and a caller that cannot see which field it got wrong will
 * guess.
 */
export function blind(workspaceId: string, raw: unknown): Blinded {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'invalid_request',
      '`dimensions` must be an object of name/value strings.');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_DIMENSIONS) {
    throw new ApiError(400, 'invalid_request',
      `At most ${MAX_DIMENSIONS} dimensions may be declared; ${entries.length} were sent.`);
  }

  const out: Blinded = {};
  for (const [name, value] of entries) {
    if (!NAME.test(name)) {
      throw new ApiError(400, 'invalid_request',
        `Dimension name "${name}" is not usable. Names are lowercase, start with a letter, `
        + 'and may contain letters, digits and underscores.');
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE) {
      throw new ApiError(400, 'invalid_request',
        `Dimension "${name}" must be a string of 1 to ${MAX_VALUE} characters. `
        + 'Send the identifier itself — only a keyed hash of it is stored.');
    }
    out[name] = blindOne(workspaceId, name, value);
  }
  return out;
}

/** The spend-window scope a blinded dimension counts against. */
export const scopeForDimension = (name: string, blinded: string) => `dim:${name}:${blinded}`;

/**
 * Does a caller-supplied value correspond to this stored dimension?
 *
 * For the console and for reconciliation: an operator who knows the account
 * number can ask "is this the effect that went there" without Ratchet ever
 * having held it. Constant-time, because answering faster for a near-miss would
 * turn a lookup into an oracle.
 */
export function matches(workspaceId: string, name: string, value: string, stored: string): boolean {
  const a = Buffer.from(blindOne(workspaceId, name, value), 'utf8');
  const b = Buffer.from(stored, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
