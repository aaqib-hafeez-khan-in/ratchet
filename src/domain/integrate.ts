/**
 * Self-service integration, for callers that are not people.
 *
 * An agent that discovers this service through /llms.txt, the agent manifest,
 * or an OpenAPI index has everything it needs to describe the API — and still
 * has to invent the integration. This endpoint removes that step: it hands back
 * code for the caller's own runtime, correct enough to run.
 *
 * The recipes are deliberately opinionated about the one thing callers get
 * wrong. An idempotency key derived from a timestamp, a UUID, or a retry
 * counter turns the gate into an expensive no-op, because every attempt looks
 * like new work. Every recipe below derives the key from the work itself, and
 * says so in a comment that survives being pasted somewhere else.
 */

export interface Recipe {
  runtime: string;
  title: string;
  language: string;
  filename: string;
  install?: string;
  code: string;
  notes: string[];
}

const KEY_RULE =
  'Derive the idempotency key from the work itself — the order, the recipient, the period. ' +
  'Never from a UUID, a timestamp, or a retry counter: those differ on every attempt, so the ' +
  'gate would authorise every one of them.';

const DECISIONS =
  'Only "execute" authorises the action. "duplicate", "in_flight", "blocked", ' +
  '"approval_required" and "denied" all mean do not act.';

export function recipes(base: string): Recipe[] {
  return [
    {
      runtime: 'http',
      title: 'Raw HTTP — any language, any platform',
      language: 'http',
      filename: 'ratchet.http',
      code: `# 0. You do not need a key for the first call. This works right now:
#    curl -X POST ${base}/v1/effects/begin -H 'content-type: application/json' \\
#      -d '{"effect_type":"email.send","idempotency_key":"welcome:user_123","payload":{}}'
#    The response carries a workspace and an api_key. Store it; it is shown once.

# 1. Ask BEFORE the side effect.
POST ${base}/v1/effects/begin
Authorization: Bearer $RATCHET_API_KEY
Content-Type: application/json

{
  "effect_type": "email.send",
  "idempotency_key": "invoice:2026-08:acct_8812",
  "payload": { "to": "customer@example.com", "template": "invoice" },
  "estimated_cost_micros": 0
}

# → { "decision": "execute", "effect_id": "eff_...", "lease_token": "lt_..." }
#   Act ONLY on "execute".

# 2. Report AFTER it, with the lease token from step 1.
POST ${base}/v1/effects/eff_.../report
Authorization: Bearer $RATCHET_API_KEY
Content-Type: application/json

{ "lease_token": "lt_...", "outcome": "succeeded", "result": { "message_id": "..." } }

# If you crash between 1 and 2, the lease lapses and the effect becomes
# "indeterminate" — a known unknown. The next caller is blocked rather than
# waved through, which is the entire point.`,
      notes: [KEY_RULE, DECISIONS],
    },
    {
      runtime: 'python',
      title: 'Python — a gate around any side effect',
      language: 'python',
      filename: 'ratchet.py',
      install: 'pip install requests',
      code: `import os, requests

BASE = "${base}"
KEY  = os.environ["RATCHET_API_KEY"]
H    = {"Authorization": f"Bearer {KEY}"}


def gated(effect_type: str, idempotency_key: str, payload: dict, do_it):
    """Run do_it() at most once for this key, ever, across every process."""
    d = requests.post(f"{BASE}/v1/effects/begin", headers=H, json={
        "effect_type": effect_type,
        "idempotency_key": idempotency_key,
        "payload": payload,
    }, timeout=10).json()

    if d["decision"] == "duplicate":
        return d.get("result")          # already done; replay the outcome
    if d["decision"] != "execute":
        # in_flight | blocked | approval_required | denied
        raise RuntimeError(f"not authorised: {d['decision']}")

    try:
        result = do_it()
    except Exception as e:
        requests.post(f"{BASE}/v1/effects/{d['effect_id']}/report", headers=H,
                      json={"lease_token": d["lease_token"],
                            "outcome": "failed", "error": str(e)}, timeout=10)
        raise

    requests.post(f"{BASE}/v1/effects/{d['effect_id']}/report", headers=H,
                  json={"lease_token": d["lease_token"],
                        "outcome": "succeeded", "result": result}, timeout=10)
    return result


# The key comes from the work, so a retry produces the same key.
gated("email.send", "invoice:2026-08:acct_8812",
      {"to": "customer@example.com"},
      lambda: send_invoice("acct_8812"))`,
      notes: [
        KEY_RULE,
        'If do_it() succeeds but reporting fails, do not swallow it. An unreported lease '
        + 'becomes "indeterminate", and that is the honest state — better than recording a '
        + 'success you cannot prove.',
      ],
    },
    {
      runtime: 'node',
      title: 'Node / TypeScript — a gate around any side effect',
      language: 'javascript',
      filename: 'ratchet.mjs',
      code: `const BASE = "${base}";
const H = { authorization: \`Bearer \${process.env.RATCHET_API_KEY}\`,
            'content-type': 'application/json' };

const post = (path, body) =>
  fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) })
    .then((r) => r.json());

export async function gated(effectType, idempotencyKey, payload, doIt) {
  const d = await post('/v1/effects/begin', { effect_type: effectType,
    idempotency_key: idempotencyKey, payload });

  if (d.decision === 'duplicate') return d.result;   // already done
  if (d.decision !== 'execute') throw new Error(\`not authorised: \${d.decision}\`);

  let result;
  try {
    result = await doIt();
  } catch (err) {
    await post(\`/v1/effects/\${d.effect_id}/report\`,
      { lease_token: d.lease_token, outcome: 'failed', error: String(err) });
    throw err;
  }
  await post(\`/v1/effects/\${d.effect_id}/report\`,
    { lease_token: d.lease_token, outcome: 'succeeded', result });
  return result;
}

// Key derived from the work — the same refund yields the same key on every retry.
await gated('payment.refund', \`refund:\${orderId}:\${amount}\`,
            { orderId, amount }, () => stripe.refunds.create({ /* … */ }));`,
      notes: [KEY_RULE, DECISIONS],
    },
    {
      runtime: 'langchain',
      title: 'LangChain — wrap a tool so it cannot fire twice',
      language: 'python',
      filename: 'ratchet_langchain.py',
      install: 'pip install langchain-core requests',
      code: `import os, requests
from langchain_core.tools import tool

BASE = "${base}"
H = {"Authorization": f"Bearer {os.environ['RATCHET_API_KEY']}"}


def gate(effect_type, key, payload):
    return requests.post(f"{BASE}/v1/effects/begin", headers=H, json={
        "effect_type": effect_type, "idempotency_key": key, "payload": payload,
    }, timeout=10).json()


@tool
def send_customer_email(account_id: str, template: str) -> str:
    """Send a templated email to a customer. This reaches a real inbox."""
    # Two agents given the same instruction derive the SAME key, so only one sends.
    key = f"email:{template}:{account_id}"
    d = gate("email.send", key, {"account_id": account_id, "template": template})

    if d["decision"] != "execute":
        # Returning this to the model rather than raising lets it explain
        # itself to the user instead of retrying blindly.
        return f"NOT SENT — the gate returned '{d['decision']}'. Do not retry; report this."

    msg_id = your_email_provider.send(account_id, template)
    requests.post(f"{BASE}/v1/effects/{d['effect_id']}/report", headers=H,
                  json={"lease_token": d["lease_token"], "outcome": "succeeded",
                        "result": {"message_id": msg_id}}, timeout=10)
    return f"sent ({msg_id})"`,
      notes: [
        KEY_RULE,
        'Hand the refusal back to the model as text. A raised exception usually triggers a '
        + 'framework retry, which is the loop you are trying to break.',
      ],
    },
    {
      runtime: 'mcp',
      title: 'MCP — the gate as tools your client already knows how to call',
      language: 'json',
      filename: 'mcp-config.json',
      install: 'npx -y ratchet-mcp',
      code: `{
  "mcpServers": {
    "ratchet": {
      "command": "npx",
      "args": ["-y", "ratchet-mcp"],
      "env": { "RATCHET_API_KEY": "rk_live_…" }
    }
  }
}`,
      notes: [
        'Works in Claude Code, Claude Desktop, Cursor, and any other client that speaks MCP over stdio.',
        'The server ships instructions telling the model to gate before acting, so the '
        + 'behaviour arrives with the tools rather than needing to be prompted in.',
        KEY_RULE,
      ],
    },
    {
      runtime: 'ollama',
      title: 'Ollama and other local models — gate the tool, not the model',
      language: 'python',
      filename: 'ratchet_ollama.py',
      install: 'pip install ollama requests',
      code: `import os, ollama, requests

BASE = "${base}"
H = {"Authorization": f"Bearer {os.environ['RATCHET_API_KEY']}"}

TOOLS = [{"type": "function", "function": {
    "name": "issue_refund",
    "description": "Refund a customer order. Moves real money.",
    "parameters": {"type": "object", "properties": {
        "order_id": {"type": "string"}, "amount_usd": {"type": "number"}},
        "required": ["order_id", "amount_usd"]}}}]


def handle(call):
    a = call["function"]["arguments"]
    # The gate sits HERE — in your code, around the tool. Not in the model,
    # which is why it works identically for a 7B local model and a frontier one.
    d = requests.post(f"{BASE}/v1/effects/begin", headers=H, json={
        "effect_type": "payment.refund",
        "idempotency_key": f"refund:{a['order_id']}:{a['amount_usd']}",
        "payload": a,
        "estimated_cost_micros": int(a["amount_usd"] * 1_000_000),
    }, timeout=10).json()

    if d["decision"] != "execute":
        return f"BLOCKED: {d['decision']}. Already initiated. Do not retry."

    do_the_refund(a)
    requests.post(f"{BASE}/v1/effects/{d['effect_id']}/report", headers=H,
                  json={"lease_token": d["lease_token"], "outcome": "succeeded"}, timeout=10)
    return "refunded"


msgs = [{"role": "user", "content": "Refund order A-771 for $49.99."}]
r = ollama.chat(model="hermes3:8b", messages=msgs, tools=TOOLS)
for call in r["message"].get("tool_calls", []):
    msgs.append({"role": "tool", "content": handle(call)})`,
      notes: [
        'The duplicate usually is not the model changing its mind — it is the run being '
        + 'restarted: a job retried, a queue redelivered, a process that acted and crashed '
        + 'before recording it. The gate is what survives that, because it is not in the process.',
        KEY_RULE,
      ],
    },
  ];
}
