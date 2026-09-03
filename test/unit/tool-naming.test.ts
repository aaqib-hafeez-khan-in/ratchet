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
