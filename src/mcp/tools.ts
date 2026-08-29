/**
 * MCP tool definitions.
 *
 * These are written for an LLM reader, not a human one. Each description says
 * exactly when to call the tool and — more importantly — what the model must
 * NOT do with the answer, because the failure mode this product exists to
 * prevent is an agent that treats "duplicate" as "try again".
 *
 * The same definitions back the stdio server, the streamable-HTTP server, and
 * the tool list published in the agent manifest, so all three cannot drift.
 */

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Scope the caller's API key must hold. */
  scope: string;
  /** Advertised to clients that support tool annotations. */
  readOnly: boolean;
}

const effectTypeProp = {
  type: 'string',
  pattern: '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$',
  description: 'Namespaced kind of side effect, e.g. "email.send", "payment.charge", "github.pr.create". Policy is configured per type.',
};

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'ratchet_begin_effect',
    title: 'Ask permission to perform a side effect',
    scope: 'effects:begin',
    readOnly: false,
    description:
      'Call this IMMEDIATELY BEFORE performing any side effect that touches the outside world ' +
      '(sending a message, charging a card, creating a resource, writing to someone else\'s system). ' +
      'Returns a decision you MUST obey:\n' +
      '- "execute": you hold the lease. Perform the action now, then call ratchet_report_effect.\n' +
      '- "duplicate": this action ALREADY HAPPENED. Do NOT perform it. Use the returned `result` as ' +
      'though you had just done the work.\n' +
      '- "in_flight": another process is doing it right now. Do NOT perform it. Wait `retry_after_seconds` and ask again.\n' +
      '- "blocked": an earlier attempt may or may not have taken effect. Do NOT perform it. Tell the ' +
      'user what is unresolved, or verify at the vendor and call ratchet_resolve_effect.\n' +
      '- "approval_required": a human must approve. Do NOT perform it.\n' +
      '- "denied": policy or budget refused it. Do NOT perform it.\n' +
      'The idempotency_key must be derived deterministically from the work itself so that a retry of ' +
      'the same logical action produces the same key. Never use a random value or the current time.',
    inputSchema: {
      type: 'object',
      required: ['effect_type', 'idempotency_key'],
      properties: {
        effect_type: effectTypeProp,
        idempotency_key: {
          type: 'string', minLength: 1, maxLength: 255,
          description: 'Deterministic identifier for this specific logical action, e.g. "welcome-email:user_123" or "invoice:2026-08:acct_88123". The SAME action retried must produce the SAME key.',
        },
        payload: {
          type: 'object', additionalProperties: true,
          description: 'The action\'s parameters. Only a hash is stored — the raw content never persists. Reusing a key with different parameters is rejected, which catches key collisions.',
        },
        estimated_cost_micros: {
          type: 'integer', minimum: 0,
          description: 'What this action will cost you at the third party, in micro-USD (1000000 = $1). Used only to enforce spend ceilings. Ratchet does not collect this.',
        },
        agent_id: { type: 'string', description: 'Identifier for you, the calling agent.' },
        run_id: { type: 'string', description: 'Groups all effects from one task or run.' },
        lease_seconds: {
          type: 'integer', minimum: 5, maximum: 3600,
          description: 'How long you expect the action to take. Report before this elapses or the effect becomes indeterminate.',
        },
      },
    },
  },
  {
    name: 'ratchet_report_effect',
    title: 'Report the outcome of an effect you executed',
    scope: 'effects:report',
    readOnly: false,
    description:
      'Call this IMMEDIATELY AFTER performing an action that ratchet_begin_effect authorised. ' +
      'Pass the lease_token you were given.\n' +
      'Report "succeeded" with a result — future duplicate callers replay that result instead of ' +
      'repeating the action.\n' +
      'Report "failed" ONLY when you are certain the action did NOT reach the outside world ' +
      '(for example, a validation error before the request was sent). That permits a clean retry.\n' +
      'If you are UNSURE whether it went through — a timeout, a dropped connection, an ambiguous ' +
      'error — do NOT report anything. Say so to the user. Letting the lease lapse records an honest ' +
      '"indeterminate", which is far safer than a false "failed" that licenses a duplicate.',
    inputSchema: {
      type: 'object',
      required: ['effect_id', 'lease_token', 'outcome'],
      properties: {
        effect_id: { type: 'string' },
        lease_token: { type: 'string' },
        outcome: { type: 'string', enum: ['succeeded', 'failed'] },
        result: {
          type: 'object', additionalProperties: true,
          description: 'What the action produced (ids, confirmation numbers, links). Replayed verbatim to duplicate callers, so include what a retry would need.',
        },
        failure_reason: { type: 'string', description: 'Required when outcome is "failed".' },
        actual_cost_micros: { type: 'integer', minimum: 0, description: 'What it really cost, if different from the estimate.' },
      },
    },
  },
  {
    name: 'ratchet_check_effect',
    title: 'Check whether an action has already been done',
    scope: 'effects:read',
    readOnly: true,
    description:
      'Look up the recorded state of an action WITHOUT reserving a lease and without consuming ' +
      'your plan allowance. Use it to answer "did I already do this?" — for example when resuming ' +
      'after a crash, or when a user asks whether something went through. To actually perform work, ' +
      'use ratchet_begin_effect instead; this tool never grants permission.',
    inputSchema: {
      type: 'object',
      required: ['effect_type', 'idempotency_key'],
      properties: {
        effect_type: effectTypeProp,
        idempotency_key: { type: 'string' },
      },
    },
  },
  {
    name: 'ratchet_resolve_effect',
    title: 'Settle an effect whose outcome was unknown',
    scope: 'effects:admin',
    readOnly: false,
    description:
      'Use ONLY after you have checked the third-party system and now know what really happened to ' +
      'an effect that was left "indeterminate". Record "succeeded" if the action did occur, "failed" ' +
      'if it did not, or "cancelled" to abandon it. Include how you verified it in `evidence`. ' +
      'Never guess: resolving incorrectly is exactly the duplicate or lost action this service exists to prevent.',
    inputSchema: {
      type: 'object',
      required: ['effect_id', 'outcome'],
      properties: {
        effect_id: { type: 'string' },
        outcome: { type: 'string', enum: ['succeeded', 'failed', 'cancelled'] },
        evidence: { type: 'string', description: 'How you verified the real outcome. Stored in the audit trail.' },
        result: { type: 'object', additionalProperties: true },
      },
    },
  },
  {
    name: 'ratchet_list_effects',
    title: 'List recent gated effects',
    scope: 'effects:read',
    readOnly: true,
    description:
      'Review recent effects for this workspace, optionally filtered by state or run. Use it to find ' +
      'unresolved work — filter by state "indeterminate" to see every action whose outcome is unknown ' +
      'and still needs verification.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['awaiting_approval', 'pending', 'succeeded', 'failed', 'indeterminate', 'denied', 'cancelled'] },
        effect_type: effectTypeProp,
        run_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'ratchet_get_policy',
    title: 'Read the policy for an effect type',
    scope: 'policies:read',
    readOnly: true,
    description:
      'Shows how this workspace has configured a given effect type: whether it is allowed, how long a ' +
      'lease lasts, the attempt ceiling, spend limits, and — most importantly — what happens when an ' +
      'attempt ends indeterminate. Check this before designing a retry strategy.',
    inputSchema: {
      type: 'object',
      required: ['effect_type'],
      properties: { effect_type: effectTypeProp },
    },
  },
  {
    name: 'ratchet_usage',
    title: 'Check plan, credit balance, and spend',
    scope: 'workspace:read',
    readOnly: true,
    description:
      'Returns the current plan, remaining included effects for the month, prepaid credit balance, ' +
      'and today\'s declared external spend against each budget ceiling. Use it to warn a user before ' +
      'a long run exhausts an allowance or a budget.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const toolByName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
