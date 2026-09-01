/**
 * Running this repository as a program starts the MCP server.
 *
 * Which is not obvious, because the repository mostly contains the Ratchet
 * *service* — the HTTP control plane in `src/api` and its worker. Those have
 * their own entrypoints and are started by the Dockerfile at the root.
 *
 * This file exists because every MCP directory and client that tries to run a
 * repository assumes the same thing: that the thing at the front door speaks
 * MCP on stdio. Glama's build defaults to `tsx index.js`, and other tooling
 * makes the same guess. Rather than ask each of them to be configured
 * correctly, the guess is now right.
 *
 *   node index.js                 # from a clone
 *   npx -y ratchet-mcp            # the published package, same code
 *
 * The bridge holds no database connection and no server secret. Its only
 * credential is the caller's own API key, read from RATCHET_API_KEY, and it
 * starts without one — discovery works unauthenticated, so a client can list
 * the tools before anybody has configured anything.
 */
import './packages/ratchet-mcp/bin/ratchet-mcp.mjs';
