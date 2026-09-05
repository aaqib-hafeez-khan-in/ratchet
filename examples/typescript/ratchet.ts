// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Ratchet — minimal TypeScript integration. No dependencies beyond fetch.
 *
 * `gate()` wraps a side effect so retry semantics are correct by construction.
 */

export type Decision =
  | 'execute' | 'duplicate' | 'in_flight' | 'blocked' | 'approval_required' | 'denied';

export interface BeginResponse {
  decision: Decision;
  effect_id: string;
  attempt: number;
  lease_token?: string;
  lease_expires_at?: string;
  result?: unknown;
  retry_after_seconds?: number;
  reason?: string;
  billing: { metered: boolean; included_remaining: number | null };
}

export class AlreadyDone<T> extends Error {
  constructor(readonly result: T) { super('effect already completed'); }
}

export class NotPermitted extends Error {
  constructor(readonly decision: Decision, readonly reason: string, readonly effectId: string) {
    super(`${decision}: ${reason}`);
  }
}

/**
 * Throw this — and only this — when you know for certain the side effect never
 * reached the outside world. Never for a timeout or an ambiguous error.
 */
export class DidNotHappen extends Error {}

export interface GateOptions {
  effectType: string;
  idempotencyKey: string;
  payload?: unknown;
  estimatedCostMicros?: number;
  agentId?: string;
  runId?: string;
  leaseSeconds?: number;
}

export class Ratchet {
  constructor(
    private readonly baseUrl = process.env.RATCHET_BASE_URL ?? 'http://localhost:8787',
    private readonly apiKey = process.env.RATCHET_API_KEY ?? '',
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/v1${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`ratchet ${data?.error?.code}: ${data?.error?.message}`);
    return data as T;
  }

  /**
   * Run `work` at most once for this idempotency key.
   *
   * Returns whatever `work` returns. If the effect already completed, throws
   * AlreadyDone carrying the recorded result — catch it and reuse the value.
   *
   * If `work` throws DidNotHappen, the effect is reported failed and a later
   * attempt is permitted. Any other exception leaves the effect UNREPORTED on
   * purpose: the outcome is genuinely unknown, so the lease lapses and Ratchet
   * records `indeterminate` rather than a convenient lie.
   */
  async gate<T>(opts: GateOptions, work: () => Promise<{ result: T; costMicros?: number }>): Promise<T> {
    const gate = await this.post<BeginResponse>('/effects/begin', {
      effect_type: opts.effectType,
      idempotency_key: opts.idempotencyKey,
      payload: opts.payload ?? {},
      estimated_cost_micros: opts.estimatedCostMicros ?? 0,
      ...(opts.agentId ? { agent_id: opts.agentId } : {}),
      ...(opts.runId ? { run_id: opts.runId } : {}),
      ...(opts.leaseSeconds ? { lease_seconds: opts.leaseSeconds } : {}),
    });

    if (gate.decision === 'duplicate') throw new AlreadyDone(gate.result as T);
    if (gate.decision !== 'execute') {
      throw new NotPermitted(gate.decision, gate.reason ?? '', gate.effect_id);
    }

    let outcome: { result: T; costMicros?: number };
    try {
      outcome = await work();
    } catch (err) {
      if (err instanceof DidNotHappen) {
        await this.post(`/effects/${gate.effect_id}/report`, {
          lease_token: gate.lease_token,
          outcome: 'failed',
          failure_reason: err.message.slice(0, 1024),
        });
      }
      throw err;
    }

    await this.post(`/effects/${gate.effect_id}/report`, {
      lease_token: gate.lease_token,
      outcome: 'succeeded',
      result: outcome.result,
      ...(outcome.costMicros !== undefined ? { actual_cost_micros: outcome.costMicros } : {}),
    });
    return outcome.result;
  }
}

// --------------------------------------------------------------------- usage

async function main() {
  const ratchet = new Ratchet();

  async function createPullRequest(repo: string, branch: string, title: string) {
    try {
      return await ratchet.gate(
        {
          effectType: 'github.pr.create',
          idempotencyKey: `pr:${repo}:${branch}`,   // same branch, same key
          payload: { repo, branch, title },
          agentId: 'coding-agent',
        },
        async () => {
          // ---- the real side effect ----
          const pr = { number: 42, url: `https://github.com/${repo}/pull/42` };
          return { result: pr };
        },
      );
    } catch (err) {
      if (err instanceof AlreadyDone) {
        console.log('PR already exists; reusing it.');
        return err.result as { number: number; url: string };
      }
      if (err instanceof NotPermitted && err.decision === 'blocked') {
        throw new Error(
          `A previous attempt may have opened this PR. Check GitHub, then resolve ${err.effectId}.`);
      }
      throw err;
    }
  }

  console.log(await createPullRequest('acme/api', 'feature-auth', 'Add auth'));
  console.log(await createPullRequest('acme/api', 'feature-auth', 'Add auth'));
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
