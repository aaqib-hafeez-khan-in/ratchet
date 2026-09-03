/**
 * The MCP tool names are read by models, and Glama scores them.
 *
 * They used to be a fifty-fifty split between `verb_noun`
 * (ratchet_begin_effect) and `noun_noun` (ratchet_circuit_status,
 * ratchet_effect_receipts, ratchet_usage), which is exactly what a Naming
 * Consistency score of 3/5 looks like. A model choosing between fifteen tools
 * does the same work a scorer does: it pattern-matches, and two patterns is one
 * too many.
 *
 * The scheme is now `ratchet_<verb>_<object>` with a small closed set of verbs.
 * These tests exist so the next tool added has to join it rather than start a
 * third pattern.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { MCP_TOOLS as TOOLS } from '../../src/mcp/tools.js';

/** Every verb a tool may start with. Adding one here should be a decision. */
const VERBS = new Set([
  'begin', 'report', 'extend', 'resolve', 'unwind', 'reconcile',  // it does something
  'get', 'list',                                                  // it reads something
]);

const names = TOOLS.map((t) => t.name);

describe('tool naming', () => {
  test('there are tools to check', () => {
    assert.ok(names.length >= 10, `only found ${names.length}`);
  });

  test('every name is ratchet_<verb>_<object>', () => {
    for (const n of names) {
      assert.match(n, /^ratchet_[a-z]+_[a-z_]+$/, `${n} does not fit the scheme`);
    }
  });

  test('every verb comes from the closed set', () => {
    for (const n of names) {
      const verb = n.split('_')[1]!;
      assert.ok(VERBS.has(verb),
        `${n} starts with "${verb}", which is not one of: ${[...VERBS].join(', ')}. `
        + 'Either use an existing verb or add this one deliberately.');
    }
  });

  test('reads are get_ for one thing and list_ for many', () => {
    for (const n of names) {
      const [, verb, ...rest] = n.split('_');
      const object = rest.join('_');
      if (verb === 'list') {
        assert.ok(object.endsWith('s'), `${n} lists, so the object should be plural`);
      }
      if (verb === 'get' && object !== 'prevented_loss') {
        assert.equal(object.endsWith('s'), false,
          `${n} gets one thing, so the object should be singular`);
      }
    }
  });

  test('no two tools differ only by a word that means the same thing', () => {
    // "status", "info", "details" and "state" are the words that creep back in
    // and quietly restart the noun_noun pattern.
    for (const n of names) {
      for (const banned of ['_status', '_info', '_details', '_state', '_data']) {
        assert.equal(n.endsWith(banned), false,
          `${n} ends in "${banned}" — say what it gets, not that it is a status`);
      }
    }
  });

  test('names are unique', () => {
    assert.equal(new Set(names).size, names.length);
  });

  test('every tool has a description a model can act on', () => {
    for (const t of TOOLS) {
      assert.ok(t.description && t.description.length > 60,
        `${t.name} has no usable description`);
    }
  });
});

/**
 * The published README is a contract surface too.
 *
 * `packages/ratchet-mcp/README.md` ships inside the npm tarball, so it is the
 * first thing anyone reads on the package page. When the tools were renamed it
 * was not renamed with them, and 0.2.0 went out documenting two tools that no
 * longer existed — a reader following it would have called a name the server
 * rejects. The rename tests above only ever looked at the source.
 */
/**
 * The bridge claims to run anywhere Node does, so it must not quietly acquire a
 * reason not to. A single native module, shell-out or Windows path assumption
 * would make the README's claim false on somebody's machine — and the person who
 * finds out is a customer on the operating system nobody tested.
 */
describe('the bridge runs everywhere it says it does', () => {
  const bin = readFileSync(
    new URL('../../packages/ratchet-mcp/bin/ratchet-mcp.mjs', import.meta.url), 'utf8');

  test('it branches on no platform and shells out to nothing', () => {
    for (const smell of ['process.platform', 'child_process', 'node:os',
                         'os.homedir', 'path.sep', 'execSync', 'spawnSync']) {
      assert.equal(bin.includes(smell), false,
        `the bridge uses ${smell}, so "runs on macOS, Linux, Windows and BSD" `
        + 'is no longer something we know to be true');
    }
  });

  test('it depends on nothing that has to be compiled', () => {
    const imports = [...bin.matchAll(/^import .*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
    for (const i of imports) {
      assert.ok(i.startsWith('node:'),
        `${i} is a third-party import — the bridge ships as one dependency-free `
        + 'file precisely so there is nothing to install and nothing to build');
    }
  });

  test('the README says so, since that is what a directory reads', () => {
    const readme = readFileSync(
      new URL('../../packages/ratchet-mcp/README.md', import.meta.url), 'utf8');
    assert.match(readme, /macOS, Linux, Windows and BSD/);
  });
});

describe('documented names are real names', () => {
  const real = new Set(names);

  /** Every surface a user reads a tool name from, published or on the site. */
  const surfaces = [
    'README.md',
    'packages/ratchet-mcp/README.md',
    'web',
    'examples',
  ];

  const root = new URL('../../', import.meta.url);

  function filesUnder(rel: string): string[] {
    const path = new URL(rel, root);
    if (!existsSync(path)) return [];
    if (!statSync(path).isDirectory()) return [rel];
    return readdirSync(path, { recursive: true, encoding: 'utf8' })
      .map((f) => `${rel}/${f}`)
      .filter((f) => statSync(new URL(f, root)).isFile())
      .filter((f) => /\.(md|html|js|ts|py|json|sh)$/.test(f));
  }

  test('no user-facing file names a tool that does not exist', () => {
    const bad: string[] = [];
    for (const surface of surfaces) {
      for (const file of filesUnder(surface)) {
        const text = readFileSync(new URL(file, root), 'utf8');
        for (const m of text.matchAll(/ratchet_[a-z_]+/g)) {
          if (!real.has(m[0])) bad.push(`${file} names ${m[0]}`);
        }
      }
    }
    assert.deepEqual(bad, [],
      'a reader following these would call a name the server rejects');
  });

  test('the published README documents only current names', () => {
    const readme = readFileSync(
      new URL('packages/ratchet-mcp/README.md', root), 'utf8');
    const documented = [...readme.matchAll(/`(ratchet_[a-z_]+)`/g)].map((m) => m[1]!);
    assert.ok(documented.length >= 5, 'the tool table should still be there');
    for (const n of documented) {
      assert.ok(real.has(n), `the npm package page documents ${n}, which does not exist`);
    }
  });
});
