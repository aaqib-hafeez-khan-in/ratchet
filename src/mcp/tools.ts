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
    name: 'ratchet_get_circuit',
    title: 'Check whether surge containment is holding your work',
    scope: 'policies:read',
    readOnly: true,
    description:
      'Call this when a begin returned "approval_required" or "denied" and the reason mentions ' +
      'a circuit breaker. A breaker opens when an effect type is being performed far more often ' +
      'than its configured hourly ceiling — usually because something is looping.\n' +
      '\nWhat to do with the answer:\n' +
      '- If a breaker is open, STOP creating effects of that type. Retrying will not help and ' +
      'each attempt is recorded.\n' +
      '- resets_at tells you when it closes itself. If it is null, a human opened it deliberately ' +
      'and only a human will close it — do not wait, and do not poll.\n' +
      '- Report the reason to your operator and stop. Do not attempt to work around it by ' +
      'renaming the effect type, splitting the work across keys, or using a different ' +
      'idempotency key: that defeats a safety control that exists to protect the people your ' +
      'actions reach.\n' +
      '- effect_type "*" means every effect type in the workspace is stopped.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ratchet_begin_effect',
    title: 'Ask permission to perform a side effect',
    scope: 'effects:begin',
    readOnly: false,
    description:
      'Call this IMMEDIATELY BEFORE performing any side effect that touches the outside world ' +
      '(sending a message, charging a card, creating a resource, writing to someone else\'s system). ' +
      'Returns a decision you MUST obey. If the response carries budget_warning, a spend '+
      'ceiling exists but nothing was counted toward it — surface that to the operator '+
      'rather than ignoring it. If it carries integration_warning, you have been beginning '+
      'effects without reporting them: call ratchet_report_effect after every action, and '+
      'tell the operator, because the effects already begun will start being blocked.\n' +
      'Decisions:\n' +
      '- "execute": you hold the lease. Perform the action now, then call ratchet_report_effect.\n' +
      '  If the response carries vendor_idempotency_key, send that key to the vendor as ITS own '+
      'idempotency key (the response says where it goes). Where enforced is true the vendor '+
      'itself will then refuse a duplicate, which protects the action even if some other '+
      'caller skips this gate entirely.\n' +
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
          description: 'What this action will cost at the third party, in micro-USD (1000000 = $1). ALWAYS SEND THIS when the action costs money. Spend ceilings are computed from it, and a ceiling with nothing declared against it never fires — the operator would be relying on a limit that cannot trigger. If the response contains budget_warning, that is exactly what has happened: tell the operator. Ratchet does not collect this money; it only counts it.',
        },
        dimensions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Who or what this action is aimed at, most often the destination: {"counterparty":"acct_1234"}. SEND THIS whenever the action targets a specific recipient, account or customer. It is how a per-destination ceiling can exist at all — "no more than $200 to any one counterparty per day" — and only a keyed hash of the value is stored, so Ratchet counts the destination without ever being able to read it. Declaring can only tighten: it never removes a limit. If begin is refused with dimension_required, the operator has made a dimension mandatory for this effect type and you must send it.',
        },
        agent_id: { type: 'string', description: 'Identifier for you, the calling agent.' },
        run_id: { type: 'string', description: 'Groups all effects from one task or run.' },
        lease_seconds: {
          type: 'integer', minimum: 5, maximum: 3600,
          description: 'How long you expect the action to take. Report before this elapses or the effect becomes indeterminate.',
        },
        vendor: {
          type: 'string', maxLength: 32,
          description: 'Which vendor performs this effect (e.g. "stripe", "square", "adyen"). '
            + 'Shapes vendor_idempotency_key so it satisfies that vendor\'s rules.',
        },
        group_key: {
          type: 'string',
          description: 'Use when this action is one step of a multi-step workflow that must succeed or fail as a whole, e.g. "booking:trip_8812". Lets the whole unit be rolled back later.',
        },
        compensation: {
          type: 'object',
          description: 'How to undo THIS step if the workflow has to be rolled back. Declare it now, while you still know what undoing means — it cannot be worked out later. Steps without one are permanent.',
          required: ['effect_type', 'payload'],
          properties: {
            effect_type: { type: 'string', description: 'e.g. "booking.cancel", "payment.refund"' },
            payload: { type: 'object', additionalProperties: true, description: 'What the undo will need — booking ids, charge ids.' },
          },
        },
        compensates_effect_id: {
          type: 'string',
          description: 'Set when THIS call IS an undo, naming the effect it reverses. Comes from ratchet_unwind_group.',
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
    name: 'ratchet_extend_lease',
    title: 'Say you are still working on an effect',
    scope: 'effects:report',
    readOnly: false,
    description:
      'Call this periodically during a long action you were authorised to perform, before the ' +
      'lease expires. It tells Ratchet you are alive and extends your hold.\n' +
      'Use it when work turns out to take longer than the lease you asked for — a slow vendor, ' +
      'a large export, a retrying upload. Without it, the lease expires while you are still ' +
      'working, the effect is recorded as having an UNKNOWN outcome, and your report is then ' +
      'refused.\n' +
      'If it fails with lease_expired or lease_lost, STOP. Your hold is gone and the outcome is ' +
      'already recorded as unknown. Do not keep going and do not retry the action — call ' +
      'ratchet_begin_effect to find out where things actually stand.',
    inputSchema: {
      type: 'object',
      required: ['effect_id', 'lease_token'],
      properties: {
        effect_id: { type: 'string' },
        lease_token: { type: 'string' },
        extend_seconds: { type: 'integer', minimum: 5, maximum: 3600,
          description: 'How much longer you need, from now. Clamped to the policy maximum.' },
      },
    },
  },
  {
    name: 'ratchet_get_effect',
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
    name: 'ratchet_get_run',
    title: 'What have I already done in this run?',
    scope: 'effects:read',
    readOnly: true,
    description:
      'Recall the work already gated under a run id, before doing anything that might repeat it. '
      + 'Call this FIRST when resuming a task — after a restart, a handoff, or when your context '
      + 'has been compacted and you are no longer certain what you did. It returns what succeeded '
      + 'with the recorded results, what is still in flight, what failed, and — separately, because '
      + 'it is the only category that can hurt you — what has an unknown outcome. Anything under '
      + '"done" has already happened: use its result rather than performing it again. Costs about a '
      + 'seventeenth of the context of listing the same effects.',
    inputSchema: {
      type: 'object',
      required: ['run_id'],
      properties: {
        run_id: {
          type: 'string', maxLength: 128,
          description: 'The run id you passed to ratchet_begin_effect for this task.',
        },
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
    name: 'ratchet_unwind_group',
    title: 'Roll back a multi-step unit of work',
    scope: 'effects:admin',
    readOnly: false,
    description:
      'Call this when a multi-step workflow fails partway and the steps that already succeeded ' +
      'must be undone — a booking made but not paid for, a resource created but not configured.\n' +
      'Returns the exact compensations to perform, in the order to perform them, which is the ' +
      'REVERSE of the order they succeeded in. Undoing forwards can strand a step that depended ' +
      'on an earlier one.\n' +
      'Ratchet does NOT perform the compensations. For each step: call ratchet_begin_effect with ' +
      'the step\'s suggested_idempotency_key and compensates_effect_id, do the real undo, then ' +
      'call ratchet_report_effect. Gating the undo is what stops a retry from refunding twice.\n' +
      'Read `unresolved` first. If any effect in the group has an unknown outcome, STOP and ' +
      'resolve it before undoing anything around it. Read `irreversible` too: those steps ' +
      'succeeded and declared no way to undo themselves, so a human has to decide what to do ' +
      'about them. Say so plainly rather than implying the rollback was complete.',
    inputSchema: {
      type: 'object',
      required: ['group_key'],
      properties: {
        group_key: { type: 'string', description: 'The unit of work to roll back, e.g. "booking:trip_8812".' },
        reason: { type: 'string', description: 'Why it is being rolled back. Stored for the operator.' },
      },
    },
  },
  {
    name: 'ratchet_get_group',
    title: 'Inspect a unit of work',
    scope: 'effects:read',
    readOnly: true,
    description:
      'Shows every step in a multi-step unit of work: what succeeded, what can still be undone, ' +
      'what has already been undone, what is irreversible, and what has an unknown outcome. ' +
      'Use it to answer "where did this workflow actually get to?" after a crash, without ' +
      'changing anything.',
    inputSchema: {
      type: 'object',
      required: ['group_key'],
      properties: { group_key: { type: 'string' } },
    },
  },
  {
    name: 'ratchet_get_usage',
    title: 'Check plan, credit balance, and spend',
    scope: 'workspace:read',
    readOnly: true,
    description:
      'Returns the current plan, remaining included effects for the month, prepaid credit balance, ' +
      'and today\'s declared external spend against each budget ceiling. Use it to warn a user before ' +
      'a long run exhausts an allowance or a budget.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ratchet_list_receipts',
    title: 'Get signed proof of the decisions on an effect',
    scope: 'effects:read',
    readOnly: true,
    description:
      'Returns a signed receipt for every decision made about one effect, refusals included. ' +
      'Each signature is over the exact bytes in `body` and verifies offline against the ' +
      'Ed25519 key published at /.well-known/ratchet-receipt-key — you do not have to trust ' +
      'this server to check them. Use this when a human asks you to PROVE an action was or ' +
      'was not authorised, rather than asserting it.',
    inputSchema: {
      type: 'object',
      required: ['effect_id'],
      properties: {
        effect_id: { type: 'string', description: 'The effect to fetch receipts for.' },
      },
    },
  },
  {
    name: 'ratchet_reconcile_effects',
    title: 'Find real-world actions that bypassed the gate',
    scope: 'effects:read',
    readOnly: true,
    description:
      'Given the idempotency keys for actions a vendor says actually happened, returns which ' +
      'ones went through Ratchet and which it has never seen. The unseen ones are code paths ' +
      'that acted WITHOUT asking, so a retry there can act twice — a bug the operator almost ' +
      'certainly does not know about. Send references only; never send credentials.',
    inputSchema: {
      type: 'object',
      required: ['effect_type', 'keys'],
      properties: {
        effect_type: { type: 'string' },
        keys: {
          type: 'array', items: { type: 'string' }, maxItems: 1000,
          description: 'Idempotency keys your system should have used for those actions.',
        },
      },
    },
  },
  {
    name: 'ratchet_get_prevented_loss',
    title: 'What the gate has actually saved',
    scope: 'effects:read',
    readOnly: true,
    description:
      'Counts duplicate actions refused in the last 30 days and what they would have cost. ' +
      'Only counts refusals where a cost was declared on the effect, so it under-reports ' +
      'rather than flatters. IMPORTANT: pass estimated_cost_micros on ratchet_begin_effect ' +
      'or this reads zero — the number is only as good as what callers declare. This is ' +
      'money not spent at your vendors, never money paid to Ratchet.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const toolByName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
