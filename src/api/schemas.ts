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
      /**
       * $10,000,000 per effect.
       *
       * This was 1e9 micro-USD — one thousand dollars — since the first commit,
       * with no reason recorded. It is a sanity bound against a typo, not a
       * product decision, and at $1,000 it quietly excluded every use case this
       * service argues for on the fraud page: a payout batch, a wire, a treasury
       * sweep. It also made the canonical structuring example — amounts pressed
       * under a $10,000 line — impossible to express through the API at all.
       *
       * The new bound is still a bound. Spend accumulates into a BIGINT, whose
       * range is about 9.2e18 micro-USD, so a single window would need something
       * like nine hundred thousand maximum-value effects to approach it.
       */
      type: 'integer', minimum: 0, maximum: 10_000_000_000_000, default: 0,
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
    dimensions: {
      type: 'object',
      maxProperties: 8,
      additionalProperties: { type: 'string', minLength: 1, maxLength: 256 },
      propertyNames: { pattern: '^[a-z][a-z0-9_]{0,31}$' },
      description:
        'Axes this effect can be counted against, most usefully the counterparty: '
        + '{"counterparty":"acct_1234"}. Send the identifier itself — only a keyed hash '
        + 'is stored, so Ratchet can count how much has gone to a destination today '
        + 'without ever being able to say which destination it is. A declaration can only '
        + 'TIGHTEN: it adds whatever ceiling policy keys on that dimension, and never '
        + 'removes the workspace, key or effect-type ceilings. Omitting one that policy '
        + 'requires is refused with `dimension_required`.',
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
    integration_warning: {
      type: 'string',
      description:
        'Present when this workspace has never reported an outcome and unreported '
        + 'effects are accumulating. Every begin must be followed by POST '
        + '/v1/effects/{effect_id}/report. '
        + 'Unreported effects become "indeterminate" when their lease expires, and the next '
        + 'attempt on the same idempotency_key is then blocked until an operator resolves it.',
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

export const agentListSchema = {
  type: 'object',
  properties: {
    data: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          agent_id: { type: 'string' },
          effects: { type: 'integer' },
          concluded: {
            type: 'integer',
            description: 'Effects that ended, and the denominator report_rate was computed over.',
          },
          report_rate: {
            type: ['number', 'null'],
            description: 'Share of concluded effects this agent reported an outcome for. '
              + 'null below the volume floor, where the figure would be noise.',
          },
          last_seen: { type: 'string' },
        },
      },
    },
    window: { type: 'object', properties: { days: { type: 'integer' } } },
  },
} as const;

export const agentReliabilitySchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    agent_id: { type: 'string' },
    window: { type: 'object', additionalProperties: true },
    volume: { type: 'object', additionalProperties: true },
    reporting: {
      type: 'object', additionalProperties: true,
      description: 'An effect whose lease ended with no report is indeterminate: the agent took '
        + 'permission to act and never said what happened. report_rate is the headline.',
    },
    decisions: {
      type: 'object', additionalProperties: true,
      description: 'What begin answered, counted from the receipt of every call - including '
        + 'calls that created no effect, which is where retry behaviour shows up.',
    },
    keys: {
      type: 'object', additionalProperties: true,
      description: 'Identical work arriving under several idempotency keys means the agent mints '
        + 'a key per attempt, so the gate cannot recognise a retry and permits it.',
    },
    cost: {
      type: 'object', additionalProperties: true,
      description: 'Declared estimate against what was actually spent. A ceiling with nothing '
        + 'counted against it can never fire.',
    },
    lease: { type: 'object', additionalProperties: true },
    concerns: {
      type: 'array',
      description: 'Plain sentences, worst first. Empty when nothing crosses a threshold. '
        + 'There is deliberately no composite score.',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          detail: { type: 'string' },
        },
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
    // Matches estimated_cost_micros: declaring an amount you then cannot report
    // would leave the reservation permanently unreconciled.
    actual_cost_micros: { type: 'integer', minimum: 0, maximum: 10_000_000_000_000 },
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

export const runListSchema = {
  type: 'object',
  properties: {
    runs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          run_id: { type: 'string' },
          limit_micros: { type: ['integer', 'null'],
            description: 'Null when no wallet was opened — an unbudgeted run is not capped.' },
          spent_micros: { type: 'integer' },
          remaining_micros: { type: ['integer', 'null'] },
          exhausted: { type: 'boolean' },
          spend_source: { type: 'string', enum: ['wallet', 'declared'],
            description:
              '"wallet" is what the gate counted and enforced against. "declared" is summed '
              + 'from what callers declared on an unbudgeted run — an estimate, not a ledger.' },
          declared_micros: { type: 'integer',
            description:
              'Everything declared on this run in the window. Reported alongside spent, not '
              + 'instead of it: a ceiling opened part-way through a run starts its ledger at '
              + 'zero, so spent alone would read as "plenty of room" on a run that has '
              + 'already spent heavily.' },
          effects: { type: 'integer' },
          last_activity_at: { type: ['string', 'null'], format: 'date-time' },
          agent_ids: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export const reconciliationStatusSchema = {
  type: 'object',
  properties: {
    effect_types: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          effect_type: { type: 'string' },
          every_hours: { type: ['integer', 'null'] },
          last_run_at: { type: ['string', 'null'], format: 'date-time' },
          hours_since_last_run: { type: ['number', 'null'] },
          due_at: { type: ['string', 'null'], format: 'date-time' },
          overdue: { type: 'boolean' },
          last_run: {
            type: ['object', 'null'],
            properties: {
              checked: { type: 'integer' },
              gated: { type: 'integer' },
              ungated: { type: 'integer' },
            },
          },
          ungated_trend: {
            type: 'array', items: { type: 'integer' },
            description:
              'Ungated counts from the last ten runs, oldest first. A rising line means '
              + 'more of your real actions are reaching the vendor without asking.',
          },
        },
      },
    },
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
    reconcile_every_hours: {
      type: ['integer', 'null'],
      description:
        'How often this effect type should be compared against the vendor\'s own record. '
        + 'Ratchet cannot perform that comparison — it keeps the calendar and says when one '
        + 'is overdue, via the reconciliation.due event.',
    },
    approval_above_micros: {
      type: ['integer', 'null'],
      description:
        'Declared cost at or above which begin returns approval_required instead of '
        + 'execute. Raises the decision only — it never turns an approval or a denial '
        + 'back into an allow. Null disables it.',
    },
    structuring_threshold_micros: {
      type: ['integer', 'null'],
      description:
        'A line watched but never enforced. Nothing is refused for exceeding it; the '
        + 'structuring analysis measures how closely declared amounts crowd it.',
    },
    required_dimensions: {
      type: 'array', maxItems: 8,
      items: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' },
      description:
        'Dimensions a caller must declare on begin, or the call is refused. Without this a '
        + 'ceiling keyed on a dimension is evaded by simply not declaring it.',
    },
    dimension_limits: {
      type: 'object', maxProperties: 8,
      propertyNames: { pattern: '^[a-z][a-z0-9_]{0,31}$' },
      additionalProperties: {
        type: 'object', additionalProperties: false,
        properties: {
          daily_micros: { type: ['integer', 'null'], minimum: 0 },
          daily_count: { type: ['integer', 'null'], minimum: 0 },
        },
      },
      description:
        'Per-dimension daily ceilings, e.g. {"counterparty":{"daily_micros":200000000,'
        + '"daily_count":20}} for "no more than $200 and no more than 20 effects to any one '
        + 'counterparty per UTC day". daily_count applies even to effects that declare no '
        + 'cost, which is what makes it usable for outbound messaging.',
    },
    surge_per_hour: { type: ['integer', 'null'],
      description: 'New effects of this type per hour above which the circuit breaker opens. '
        + 'Null disables surge containment, which is the default.' },
    surge_action: { type: 'string', enum: ['monitor', 'require_approval', 'deny'] },
    surge_cooldown_seconds: { type: 'integer' },
    surge_multiplier: { type: ['integer', 'null'],
      description: 'Relative surge threshold: how many times normal is definitely wrong. '
        + 'Use when you do not know your own traffic. Does nothing until enough history '
        + 'exists to compute a baseline.' },
    surge_baseline_per_hour: { type: ['integer', 'null'],
      description: 'Median hourly volume over the last 7 days. Computed for you.' },
    surge_effective_ceiling: { type: ['integer', 'null'],
      description: 'The hourly ceiling actually in force, whichever rule produced it.' },
    surge_ceiling_source: { type: ['string', 'null'], enum: ['absolute', 'learned', null] },
    is_default: { type: 'boolean' },
  },
} as const;

export const circuitSchema = {
  type: 'object',
  properties: {
    effect_type: { type: 'string',
      description: 'The effect type this breaker governs. "*" is the whole workspace.' },
    state: { type: 'string', enum: ['closed', 'open'] },
    action: { type: 'string', enum: ['monitor', 'require_approval', 'deny'] },
    tripped_at: { type: ['string', 'null'], format: 'date-time' },
    resets_at: { type: ['string', 'null'], format: 'date-time',
      description: 'When the breaker closes itself. Null means it was opened by hand '
        + 'and stays open until a human closes it.' },
    observed: { type: ['integer', 'null'] },
    threshold: { type: ['integer', 'null'] },
    reason: { type: ['string', 'null'] },
    opened_by: { type: ['string', 'null'] },
    trip_count: { type: 'integer' },
  },
} as const;

export const circuitListSchema = {
  type: 'object',
  properties: {
    circuits: { type: 'array', items: circuitSchema },
    rates: {
      type: 'array',
      description: 'Observed volume per effect type, to choose a threshold from.',
      items: {
        type: 'object',
        properties: {
          effect_type: { type: 'string' },
          this_hour: { type: 'integer' },
          peak_hour: { type: 'integer',
            description: 'Busiest single hour in the last 30 days.' },
        },
      },
    },
  },
} as const;

export const circuitOpenBody = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: {
    action: { type: 'string', enum: ['monitor', 'require_approval', 'deny'],
      default: 'deny',
      description: 'deny refuses outright; require_approval holds the work for a human.' },
    reason: { type: 'string', minLength: 1, maxLength: 500,
      description: 'Recorded on the breaker and shown to callers that are stopped by it.' },
  },
} as const;
