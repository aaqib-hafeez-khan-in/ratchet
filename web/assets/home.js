import { mountChrome, highlight, tabs } from '/assets/partials.js';
mountChrome('/');

const flow = `# 1. Ask, before you act.
POST /v1/effects/begin
{
  "effect_type": "email.send",
  "idempotency_key": "welcome:user_123",
  "payload": { "to": "sam@example.com" }
}

-> { "decision": "execute", "lease_token": "lt_..." }

# 2. Now do the real thing, yourself.
send_the_email()

# 3. Say what happened.
POST /v1/effects/eff_.../report
{ "lease_token": "lt_...", "outcome": "succeeded",
  "result": { "message_id": "m_9f2" } }

# Any later caller with the same key gets:
-> { "decision": "duplicate", "result": { "message_id": "m_9f2" } }`;
document.getElementById('flow-code').innerHTML = highlight(flow);

const SNIPPETS = {
  curl: `curl -X POST https://your-host/v1/effects/begin \\
  -H "Authorization: Bearer $RATCHET_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "effect_type": "email.send",
    "idempotency_key": "welcome:user_123",
    "payload": { "to": "sam@example.com" },
    "estimated_cost_micros": 800
  }'`,

  python: `import httpx

def gated(client, effect_type, key, payload, do_it):
    r = client.post("/v1/effects/begin", json={
        "effect_type": effect_type,
        "idempotency_key": key,
        "payload": payload,
    }).json()

    if r["decision"] == "duplicate":
        return r["result"]              # already done; replay it
    if r["decision"] != "execute":
        raise Blocked(r["decision"], r["reason"])

    try:
        result = do_it()                # the real side effect
    except DefinitelyDidNotSend as e:
        client.post(f"/v1/effects/{r['effect_id']}/report", json={
            "lease_token": r["lease_token"],
            "outcome": "failed", "failure_reason": str(e)})
        raise
    # If you are UNSURE it went through, report nothing. The lease lapses
    # and Ratchet records an honest "indeterminate" instead of a wrong "failed".

    client.post(f"/v1/effects/{r['effect_id']}/report", json={
        "lease_token": r["lease_token"],
        "outcome": "succeeded", "result": result})
    return result`,

  ts: `const ratchet = (path: string, body: unknown) =>
  fetch(\`\${BASE}/v1\${path}\`, {
    method: "POST",
    headers: { authorization: \`Bearer \${KEY}\`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const gate = await ratchet("/effects/begin", {
  effect_type: "github.pr.create",
  idempotency_key: \`pr:\${repo}:\${branch}\`,
  payload: { repo, branch, title },
});

if (gate.decision === "duplicate") return gate.result;
if (gate.decision !== "execute") throw new Error(gate.reason);

const pr = await octokit.pulls.create({ ... });

await ratchet(\`/effects/\${gate.effect_id}/report\`, {
  lease_token: gate.lease_token,
  outcome: "succeeded",
  result: { number: pr.data.number, url: pr.data.html_url },
});`,

  mcp: `// Claude Desktop / Claude Code / Cursor — mcp config
{
  "mcpServers": {
    "ratchet": {
      "command": "node",
      "args": ["/path/to/ratchet/dist/mcp/stdio.js"],
      "env": {
        "RATCHET_API_KEY": "rk_live_...",
        "DATABASE_URL": "postgres://..."
      }
    }
  }
}

// Or connect any MCP client over streamable HTTP:
//   POST https://your-host/mcp
//   Authorization: Bearer rk_live_...
//
// Tools: ratchet_begin_effect, ratchet_report_effect,
//        ratchet_check_effect, ratchet_resolve_effect,
//        ratchet_list_effects, ratchet_get_policy, ratchet_usage`,
};

tabs(document.getElementById('int-tabs'), (name) => {
  document.getElementById('int-code').innerHTML = highlight(SNIPPETS[name]);
});
