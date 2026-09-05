// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * The rules behind the site's copy buttons.
 *
 * A copy button makes a promise: what you paste is what runs. Every case here
 * is one way that promise was broken during development, and the JSON ones are
 * the sharpest — a config copied with a comment or a response in it fails
 * later, inside the reader's editor, with no hint that our page caused it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain browser ESM, no types, imported for its pure helpers
import { isCopyable, runnableText, NEEDS_KEY } from '../../web/assets/copy.js';

const copyOf = (raw: string) => (runnableText as (r: string) => { text: string }) (raw).text;
const copyable = isCopyable as (t: string) => boolean;

describe('what earns a copy button', () => {
  test('a real shell command does', () => {
    assert.ok(copyable('curl -X POST https://ratchetgate.com/v1/effects/begin'));
    assert.ok(copyable('npx -y ratchet-mcp'));
    assert.ok(copyable('claude mcp add ratchet -- npx -y ratchet-mcp'));
  });

  test('a JSON config does, because it is pasted into a settings file', () => {
    assert.ok(copyable('{\n  "mcpServers": { "ratchet": { "command": "npx" } }\n}'));
  });

  test('pseudo-HTTP does not — it cannot be pasted anywhere', () => {
    assert.equal(copyable('POST /v1/effects/begin\n{ "effect_type": "email.send" }'), false);
    assert.equal(copyable('PUT /v1/policies/email.send  { "surge_per_hour": 40 }'), false);
  });

  test('a structural elision does not, since no substitution completes it', () => {
    assert.equal(copyable('POST /v1/reconcile { "keys": [ … ] }'), false);
    assert.equal(copyable('npm install\n...'), false);
  });

  test('but a placeholder attached to a word does', () => {
    // "rk_live_…" is the reader's key to fill in, not content we omitted. This
    // distinction is the whole reason the MCP config has a button at all.
    assert.ok(copyable('{ "env": { "RATCHET_API_KEY": "rk_live_…" } }'));
    assert.ok(copyable('claude mcp add ratchet --env RATCHET_API_KEY=rk_live_... -- npx'));
  });
});

describe('what actually lands on the clipboard', () => {
  test('an example response is left behind', () => {
    const copied = copyOf(
      `curl -X POST https://ratchetgate.com/v1/effects/begin \\\n  -d '{}'\n\n` +
      `→ { "decision": "execute",\n    "workspace": { "api_key": "rk_live_…" } }`);
    assert.ok(copied.startsWith('curl'));
    assert.equal(copied.includes('decision'), false);
    assert.equal(copied.includes('→'), false);
    assert.equal(copied.endsWith("-d '{}'"), true, 'trailing blank lines should go too');
  });

  test('a shell prompt is not part of the command', () => {
    assert.equal(copyOf('$ npm install ratchet-mcp'), 'npm install ratchet-mcp');
  });

  test('comments around a JSON body are removed from both ends', () => {
    const copied = copyOf(
      `// claude_desktop_config.json, or Cursor's .cursor/mcp.json\n` +
      `{\n  "mcpServers": { "ratchet": { "command": "node" } }\n}\n\n` +
      `// The key lives in "env", never in "args".`);
    assert.doesNotMatch(copied, /^\s*\/\//m, 'a comment makes the config invalid JSON');
    assert.doesNotThrow(() => JSON.parse(copied), 'what we hand over must parse');
  });

  test('a comment in a shell block is kept, because it is valid there', () => {
    const copied = copyOf('# In your project root:\nclaude mcp add ratchet -- npx');
    assert.ok(copied.startsWith('# In your project root:'));
  });
});

describe('warning that a snippet is not ready to run', () => {
  const needsKey = (t: string) => (NEEDS_KEY as RegExp).test(t);

  test('fires on a key placeholder in either notation', () => {
    assert.ok(needsKey('{ "RATCHET_API_KEY": "rk_live_..." }'));
    assert.ok(needsKey('{ "RATCHET_API_KEY": "rk_live_…" }'));
    assert.ok(needsKey('curl -H "Authorization: Bearer rk_live_..."'));
  });

  test('stays quiet when the snippet works as pasted', () => {
    assert.equal(needsKey('curl -X POST https://ratchetgate.com/v1/effects/begin'), false);
    assert.equal(needsKey('npm install ratchet-mcp'), false);
  });
});
