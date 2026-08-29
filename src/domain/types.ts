export type EffectState =
  | 'awaiting_approval'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'indeterminate'
  | 'denied'
  | 'cancelled';

/** What the caller should do next. This is the entire product surface. */
export type Decision =
  /** You hold the lease. Perform the side effect, then report the outcome. */
  | 'execute'
  /** This effect already completed. Do NOT perform it. Replay `result`. */
  | 'duplicate'
  /** Another caller holds a live lease. Back off and re-ask. */
  | 'in_flight'
  /** A previous attempt's real-world outcome is unknown. Do NOT blindly retry. */
  | 'blocked'
  /** Policy requires an operator decision before this may run. */
  | 'approval_required'
  /** Policy, budget, or a rejected approval refused this effect. */
  | 'denied';

export interface Policy {
  workspaceId: string;
  effectType: string;
  mode: 'allow' | 'require_approval' | 'deny';
  onIndeterminate: 'block' | 'retry' | 'probe';
  leaseSeconds: number;
  maxAttempts: number;
  maxCostMicros: number | null;
  dailyBudgetMicros: number | null;
  retentionDays: number;
  /** True when no explicit row exists and workspace defaults were applied. */
  isDefault: boolean;
}

export interface EffectRow {
  id: string;
  workspace_id: string;
  effect_type: string;
  idempotency_key: string;
  fingerprint: Buffer;
  state: EffectState;
  attempt: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  leased_by_key_id: string | null;
  reserved_micros: number;
  actual_micros: number;
  request_summary: Record<string, unknown>;
  result: unknown;
  failure_reason: string | null;
  denial_reason: string | null;
  agent_id: string | null;
  run_id: string | null;
  approval_state: 'waiting' | 'approved' | 'rejected' | null;
  approved_by: string | null;
  created_at: Date;
  updated_at: Date;
  settled_at: Date | null;
  expires_at: Date;
}

export interface BeginInput {
  workspaceId: string;
  apiKeyId: string;
  apiKeyPrefix: string;
  keyDailyBudgetMicros: number | null;
  effectType: string;
  idempotencyKey: string;
  payload: unknown;
  estimatedCostMicros: number;
  agentId?: string | null;
  runId?: string | null;
  requestSummary?: Record<string, unknown>;
  /** Overrides the policy lease, clamped to [5, policy.leaseSeconds]. */
  leaseSeconds?: number | null;
}

export interface BeginResult {
  decision: Decision;
  effectId: string;
  effectType: string;
  idempotencyKey: string;
  state: EffectState;
  attempt: number;
  /** Present only when decision === 'execute'. Required to report an outcome. */
  leaseToken?: string;
  leaseExpiresAt?: string;
  /** Present when decision === 'duplicate'. The recorded outcome to replay. */
  result?: unknown;
  /** Seconds to wait before re-asking; present for 'in_flight'. */
  retryAfterSeconds?: number;
  /** Human- and agent-readable explanation for non-execute decisions. */
  reason?: string;
  /** Evidence for 'blocked': what is known about the prior attempt. */
  priorAttempt?: {
    attempt: number;
    state: EffectState;
    startedAt: string;
    lastKnownAt: string;
    onIndeterminate: Policy['onIndeterminate'];
  };
  /** Ratchet's own metering impact of this call. */
  billing: { metered: boolean; decisionsRemaining: number | null };
}

export interface ReportInput {
  workspaceId: string;
  apiKeyId: string;
  apiKeyPrefix: string;
  effectId: string;
  leaseToken: string;
  outcome: 'succeeded' | 'failed';
  result?: unknown;
  failureReason?: string;
  actualCostMicros?: number | null;
}

export const TERMINAL_STATES: ReadonlySet<EffectState> = new Set<EffectState>([
  'succeeded', 'failed', 'denied', 'cancelled',
]);
