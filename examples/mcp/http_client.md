# Connecting any MCP client over Streamable HTTP

Ratchet's HTTP transport is stateless: every request carries its own API key and
is authorised independently. There is no session to establish, nothing to keep
warm, and no state shared between tenants.

```
POST https://your-ratchet-host/mcp
Authorization: Bearer rk_live_...
Content-Type: application/json
```

## Handshake

```json
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":"2025-06-18","capabilities":{},
           "clientInfo":{"name":"my-agent","version":"1.0"}}}
```

Supported protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05`. The server
echoes whichever you request if it is supported, and otherwise its own default.

The `initialize` response carries an `instructions` string that tells the model
how to treat each decision. Surface it to your model — it is the difference
between an agent that respects `duplicate` and one that retries anyway.

## Calling a tool

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"ratchet_begin_effect",
           "arguments":{"effect_type":"email.send",
                        "idempotency_key":"welcome:user_123",
                        "payload":{"to":"sam@example.com"}}}}
```

Results come back in both `content[0].text` (JSON string) and
`structuredContent` (parsed). Every `ratchet_begin_effect` result includes a
`next_step` field written for a model to read literally: it begins with `STOP`
for every decision that is not `execute`.

## Notes

- `GET /mcp` returns `405`. Ratchet has no server-initiated messages, so it
  declines to hold an idle SSE stream open rather than pretending to.
- A batch (JSON array) is answered with an array; notifications are omitted, and
  a batch of only notifications returns `202` with no body.
- Tool-level failures come back as a normal result with `isError: true` and a
  readable `error.code`, not as a JSON-RPC protocol error — so the model can act
  on them rather than seeing a transport fault.
- Scopes are enforced per tool. A key with only `effects:begin` and
  `effects:report` can gate and report, and nothing else.
