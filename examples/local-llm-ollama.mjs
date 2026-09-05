// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos.MX
/**
 * A local model, gated.
 *
 * Local models are where this matters most. They are smaller, they lose the
 * thread of a conversation sooner, and when a tool result comes back ambiguous
 * they re-issue the call far more readily than a frontier model does. That is
 * not a flaw to apologise for — it is the normal behaviour of a retry loop, and
 * it is exactly what turns one refund into two.
 *
 * This script does not simulate that. It runs a real model against a real
 * gate, hands it the ambiguous result that happens constantly in production
 * ("upstream timed out, status unknown"), and prints what the model does next
 * and what the gate says about it.
 *
 *   ollama pull hermes3:8b
 *   RATCHET_KEY=rk_... node examples/local-llm-ollama.mjs
 */
const RATCHET = process.env.RATCHET_URL ?? 'https://ratchet-gate.fly.dev';
const KEY     = process.env.RATCHET_KEY;
const OLLAMA  = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MODEL   = process.env.OLLAMA_MODEL ?? 'hermes3:8b';
if (!KEY) throw new Error('set RATCHET_KEY');

const TOOLS = [{
  type: 'function',
  function: {
    name: 'issue_refund',
    description: 'Refund a customer order. Moves real money.',
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string' }, amount_usd: { type: 'number' } },
      required: ['order_id', 'amount_usd'],
    },
  },
}];

const chat = async (messages) => {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: false }),
  });
  return (await r.json()).message;
};

/**
 * The gate call. The key is derived from the work — order and amount — so the
 * same refund produces the same key no matter how many times the model asks,
 * or which machine in a fleet asks. A random key or a timestamp here would
 * defeat the entire mechanism.
 */
const gate = async (args) => {
  const r = await fetch(`${RATCHET}/v1/effects/begin`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      effect_type: 'payment.refund',
      idempotency_key: `refund:${args.order_id}:${args.amount_usd}`,
      payload: args,
      estimated_cost_micros: Math.round(args.amount_usd * 1e6),
      agent_id: `ollama:${MODEL}`,
      lease_seconds: Number(process.env.LEASE_SECONDS ?? 60),
    }),
  });
  return r.json();
};

const ORDER = process.env.ORDER_ID ?? 'A-771';

const messages = [
  { role: 'system', content: 'You are a payments support agent. Use tools to act. Be persistent: if an action did not clearly succeed, try again.' },
  { role: 'user', content: `Customer on order ${ORDER} was charged $49.99 twice. Refund one charge.` },
];

let refundsActuallySent = 0;

for (let turn = 1; turn <= 4; turn++) {
  const m = await chat(messages);
  messages.push(m);

  const call = m.tool_calls?.[0];
  if (!call) { console.log(`\nturn ${turn}: model stopped calling tools — "${(m.content ?? '').trim().slice(0, 120)}"`); break; }

  const args = call.function.arguments;
  const decision = await gate(args);
  if (decision.error) {
    // A failed call is NOT a successful block. Saying "money is safe" here
    // would be the demo lying to you about the thing it exists to show.
    console.error(`\nturn ${turn}: gate call FAILED — ${decision.error.code}: ${decision.error.message}`);
    console.error('This is an error, not a refusal. Nothing was demonstrated.');
    process.exit(1);
  }
  const d = decision.decision;
  console.log(`\nturn ${turn}: model called issue_refund(${args.order_id}, $${args.amount_usd})`);
  console.log(`         gate says: ${d}`);

  let toolResult;
  if (d === 'execute') {
    refundsActuallySent++;
    console.log(`         → authorised. Refund #${refundsActuallySent} sent.`);
    // The ambiguous result that causes duplicates in the real world: the
    // refund DID go through, but the caller never got a clean confirmation.
    toolResult = 'ERROR: upstream gateway timed out after 30s. Refund status unknown.';
    console.log(`         → gateway times out. Model is told the status is unknown.`);
  } else {
    console.log(`         → NOT authorised. No second refund. Money is safe.`);
    toolResult = `BLOCKED by effect gate: ${d}. This refund was already initiated. Do not retry; report to the user.`;
  }
  messages.push({ role: 'tool', content: toolResult });
}

console.log(`\n${'─'.repeat(62)}`);
console.log(`refunds the model tried to send : ${messages.filter((m) => m.tool_calls?.length).length}`);
console.log(`refunds actually sent           : ${refundsActuallySent}`);
console.log(refundsActuallySent <= 1
  ? '✓ the customer was refunded once'
  : '✗ duplicate refund escaped the gate');
