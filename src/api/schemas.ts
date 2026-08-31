/**
 * JSON Schemas shared by route definitions. Fastify validates requests and
 * serializes responses against these, and @fastify/swagger derives the OpenAPI
 * document from the same objects — so the published spec cannot drift from the
 * implementation.
 */

export const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', description: 'Stable machine-readable error code.' },
        message: { type: 'string' },
        detail: { type: 'object', additionalProperties: true },
      },
    },
  },
} as const;

export const errorResponses = {
  400: { ...errorSchema, description: 'Invalid request.' },
  401: { ...errorSchema, description: 'Missing or invalid API key.' },
  402: { ...errorSchema, description: 'Insufficient prepaid credit.' },
  403: { ...errorSchema, description: 'Scope, policy, or budget refusal.' },
  404: { ...errorSchema, description: 'Not found.' },
  409: { ...errorSchema, description: 'Conflicting state or idempotency-key reuse.' },
  413: { ...errorSchema, description: 'Payload too large.' },
  429: { ...errorSchema, description: 'Rate limit exceeded.' },
} as const;

export const beginBody = {
  type: 'object',
  required: ['effect_type', 'idempotency_key'],
  additionalProperties: false,
  properties: {
    effect_type: {
      type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$',
      description: 'Namespaced kind of side effect, e.g. "email.send" or "payment.charge". Policy is configured per type.',
    },
    idempotency_key: {
      type: 'string', minLength: 1, maxLength: 255,
      description: 'Stable identifier for this logical action. Derive it from the work itself (e.g. a hash of recipient + template + period), never from a random value or a timestamp.',
    },
    payload: {
      description: 'The action being gated. Only a fingerprint is stored; the raw value is never persisted. Reusing a key with a different payload is rejected.',
    },
    estimated_cost_micros: {
      type: 'integer', minimum: 0, maximum: 1_000_000_000, default: 0,
      description: 'Declared external cost of this effect in micro-USD (1e-6 USD). '
        + 'SEND THIS. Budget ceilings are computed from it, and a ceiling with nothing '
        + 'declared against it never triggers — the spend limit you configured would be '
        + 'silently inert. It is also what makes the prevented-loss figure meaningful. '
        + 'Ratchet never collects this money; it only counts it.',
    },
    agent_id: { type: 'string', maxLength: 128, description: 'Which agent is acting. For operator visibility.' },
    run_id: { type: 'string', maxLength: 128, description: 'Groups effects belonging to one agent run.' },
    request_summary: {
      type: 'object', additionalProperties: true,
      description: 'Small, non-sensitive metadata shown in the console. Redact secrets before sending.',
    },
    lease_seconds: {
      type: 'integer', minimum: 5, maximum: 3600,
      description: 'Requested lease length. Clamped to the policy maximum for this effect type.',
    },
    vendor: {
      type: 'string', maxLength: 32, pattern: '^[a-z0-9][a-z0-9._-]{0,31}$',
      description: 'Which vendor performs this effect (e.g. "stripe", "square", "adyen"). '
        + 'Shapes the vendor_idempotency_key returned with an execute decision so it '
        + 'satisfies that vendor\'s length and placement rules.',
    },
    group_key: {
      type: 'string', maxLength: 255,
      description: 'Declares this effect part of a unit of work that can be rolled back as a whole. Use one stable key per logical workflow, e.g. "booking:trip_8812".',
    },
    compensation: {
      type: 'object',
      required: ['effect_type', 'payload'],
      additionalProperties: false,
      description: 'How to undo this effect if the unit of work has to be rolled back. Declare it now, while you still know what undoing means — it cannot be reconstructed later.',
      properties: {
        effect_type: { type: 'string', maxLength: 64, pattern: '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$' },
        payload: { description: 'Arguments the compensating action will need.' },
      },
    },
    compensates_effect_id: {
      type: 'string', maxLength: 64,
      description: 'Set when THIS effect is the compensation for another. Reporting it succeeded marks the original reversed.',
    },
  },
} as const;

export const beginResponse = {
  type: 'object',
  required: ['decision', 'effect_id', 'effect_type', 'idempotency_key', 'state', 'attempt'],
  properties: {
    decision: {
      type: 'string',
      enum: ['execute', 'duplicate', 'in_flight', 'blocked', 'approval_required', 'denied'],
      description:
        'execute: you hold the lease, perform the effect. ' +
        'duplicate: already done, replay `result`, do NOT perform it. ' +
        'in_flight: another caller holds a live lease. ' +
        'blocked: a prior attempt\'s real-world outcome is unknown. ' +
        'approval_required: an operator must approve first. ' +
        'denied: policy, budget, or a rejected approval refused it.',
    },
    effect_id: { type: 'string' },
    effect_type: { type: 'string' },
    idempotency_key: { type: 'string' },
    state: { type: 'string', enum: ['awaiting_approval', 'pending', 'succeeded', 'failed', 'indeterminate', 'denied', 'cancelled'] },
    attempt: { type: 'integer' },
    lease_token: { type: 'string', description: 'Present only when decision is "execute". Required to report the outcome.' },
    budget_warning: {
      type: 'string',
      description:
        'Present when a spend ceiling is configured for this effect type but this call '
        + 'declared no cost, so nothing counted toward it. The ceiling cannot trigger '
        + 'until callers send estimated_cost_micros.',
    },
    workspace: {
      type: 'object',
      description:
        'Present ONLY on a keyless first call, which provisions a workspace on the spot. '
        + 'Store api_key — it is never returned again. The workspace is capped until you '
        + 'claim it with an email at POST /v1/workspaces/claim.',
      properties: {
        api_key: { type: 'string' },
        workspace_id: { type: 'string' },
        quota: { type: 'integer', description: 'Gated effects allowed before claiming.' },
      },
    },
    vendor_idempotency_key: {
      type: 'object',
      description:
        'Present only with an "execute" decision. Send `key` to the vendor as its own '
        + 'idempotency key. Where `enforced` is true the VENDOR refuses the duplicate, so '
        + 'the guarantee no longer depends on the agent choosing to ask us first. Derived '
        + 'per attempt: retrying this attempt reuses the key, while a genuine retry after '
        + 'a reported failure gets a new one so the vendor does not replay the old failure.',
      properties: {
        key: { type: 'string' },
        vendor: { type: 'string' },
        placement: { type: 'string', description: 'Where to put it in the vendor request.' },
        enforced: { type: 'boolean', description: 'True only where the vendor actually deduplicates on it.' },
        note: { type: 'string' },
      },
    },
    lease_expires_at: { type: 'string', format: 'date-time' },
    result: { description: 'Present when decision is "duplicate": the recorded outcome to replay.' },
    retry_after_seconds: { type: 'integer' },
    reason: { type: 'string' },
    prior_attempt: {
      type: 'object',
      properties: {
        attempt: { type: 'integer' },
        state: { type: 'string' },
        started_at: { type: 'string', format: 'date-time' },
        last_known_at: { type: 'string', format: 'date-time' },
        on_indeterminate: { type: 'string', enum: ['block', 'retry', 'probe'] },
      },
    },
    billing: {
      type: 'object',
      properties: {
        metered: { type: 'boolean', description: 'True only when this call created a new gated effect.' },
        included_remaining: { type: ['integer', 'null'] },
      },
    },
  },
} as const;

export const reportBody = {
  type: 'object',
  required: ['lease_token', 'outcome'],
  additionalProperties: false,
  properties: {
    lease_token: { type: 'string', minLength: 8, maxLength: 128 },
    outcome: {
      type: 'string', enum: ['succeeded', 'failed'],
      description: 'Report "failed" ONLY when you know the side effect did not reach the outside world. If you are unsure, report nothing and let the lease lapse — that records an honest `indeterminate`.',
    },
    result: { description: 'Recorded and replayed verbatim to future duplicate callers.' },
    failure_reason: { type: 'string', maxLength: 1024 },
    actual_cost_micros: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
  },
} as const;

export const effectView = {
  type: 'object',
  properties: {
    effect_id: { type: 'string' },
    effect_type: { type: 'string' },
    idempotency_key: { type: 'string' },
    state: { type: 'string' },
    attempt: { type: 'integer' },
    result: {},
    failure_reason: { type: ['string', 'null'] },
    denial_reason: { type: ['string', 'null'] },
    agent_id: { type: ['string', 'null'] },
    run_id: { type: ['string', 'null'] },
    estimated_cost_micros: { type: 'integer' },
    actual_cost_micros: { type: 'integer' },
    lease_expires_at: { type: ['string', 'null'] },
    approval_state: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    settled_at: { type: ['string', 'null'] },
  },
} as const;

export const policySchema = {
  type: 'object',
  properties: {
    effect_type: { type: 'string' },
    mode: { type: 'string', enum: ['allow', 'require_approval', 'deny'] },
    on_indeterminate: { type: 'string', enum: ['block', 'retry', 'probe'] },
    lease_seconds: { type: 'integer' },
    max_attempts: { type: 'integer' },
    max_cost_micros: { type: ['integer', 'null'] },
    daily_budget_micros: { type: ['integer', 'null'] },
    retention_days: { type: 'integer' },
    require_cost: { type: 'boolean' },
    is_default: { type: 'boolean' },
  },
} as const;
