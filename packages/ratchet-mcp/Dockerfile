# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos AI LLC
# The MCP server, and only the MCP server.
#
# The Dockerfile at the repository root builds the Ratchet *service* — the HTTP
# control plane and its worker — and its CMD starts an API server on a port.
# That is the right image for running Ratchet and the wrong one for anything
# expecting to speak MCP over stdio: a directory that builds it gets an HTTP
# server, hands it a stdio proxy, and reports "connection closed". Glama did
# exactly that, and was not wrong to.
#
# This builds the bridge instead. It is one file with no dependencies, so there
# is no install step, no lockfile, and nothing to go stale.
#
#   docker build -f packages/ratchet-mcp/Dockerfile -t ratchet-mcp .
#   docker run --rm -i -e RATCHET_API_KEY=rk_live_... ratchet-mcp

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# Nothing here needs root, and an MCP server is handed untrusted text by design.
RUN addgroup -S mcp && adduser -S mcp -G mcp
USER mcp
WORKDIR /app

COPY --chown=mcp:mcp packages/ratchet-mcp/bin/ratchet-mcp.mjs ./bin/ratchet-mcp.mjs

# Where the gate lives. Override to point at a self-hosted instance.
ENV RATCHET_BASE_URL=https://ratchetgate.com

# stdout carries the JSON-RPC stream and nothing else, so Node must not be told
# to print anything to it.
ENTRYPOINT ["node", "/app/bin/ratchet-mcp.mjs"]
