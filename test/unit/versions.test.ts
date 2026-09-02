/**
 * One version, declared once.
 *
 * There were five declarations and four different answers: the repository said
 * 0.1.0, the bridge package 0.2.0, the registry manifest 0.2.0 for the server
 * and 0.1.1 for its package, and npm had published 0.1.1. A client calling
 * `initialize` was told 0.1.0 while the registry advertised 0.2.0.
 *
 * Nothing broke. That is why it survived — every consumer read a different
 * field and each was internally consistent. It is the kind of drift a directory
 * notices before you do, and it makes a listing look unmaintained.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const json = (p: string) =>
  JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

describe('version consistency', () => {
  const repo = json('package.json').version as string;

  test('the repository version is a plain semver', () => {
    assert.match(repo, /^\d+\.\d+\.\d+$/);
  });

  test('the published bridge declares the same version', () => {
    assert.equal(json('packages/ratchet-mcp/package.json').version, repo);
  });

  test('the MCP registry manifest agrees, for the server and its package', () => {
    const manifest = json('server.json');
    assert.equal(manifest.version, repo, 'server.json server version has drifted');
    for (const pkg of manifest.packages ?? []) {
      assert.equal(pkg.version, repo,
        `server.json packages[].version has drifted (${pkg.identifier ?? 'package'})`);
    }
  });

  test('what the server tells a client on initialize is the same number', async () => {
    const { SERVER_INFO } = await import('../../src/mcp/protocol.js');
    assert.equal(SERVER_INFO.version, repo,
      'serverInfo.version must not be typed by hand — it is read from package.json');
  });
});
