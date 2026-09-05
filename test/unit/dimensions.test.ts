// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * Blinding: the property that lets a destination be counted without being read.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = process.env.AUTH_SECRET
  ?? 'test-secret-that-is-at-least-thirty-two-characters-long';

const { blind, scopeForDimension, matches, MAX_DIMENSIONS } =
  await import('../../src/lib/dimensions.js');

describe('what a blinded dimension is', () => {
  test('the same value in the same workspace is always the same identifier', () => {
    assert.equal(blind('ws_a', { counterparty: 'acct_1' }).counterparty,
                 blind('ws_a', { counterparty: 'acct_1' }).counterparty,
                 'without this a ceiling could not accumulate at all');
  });

  test('the same value in a different workspace is a different identifier', () => {
    assert.notEqual(blind('ws_a', { counterparty: 'acct_1' }).counterparty,
                    blind('ws_b', { counterparty: 'acct_1' }).counterparty,
                    'one tenant must not be able to recognise another tenant\'s counterparty');
  });

  test('the same value under a different name is a different identifier', () => {
    assert.notEqual(blind('ws_a', { counterparty: 'x' }).counterparty,
                    blind('ws_a', { recipient: 'x' }).recipient,
                    'names are domain separation, not decoration');
  });

  test('it does not resemble the input', () => {
    const out = blind('ws_a', { counterparty: 'acct_1234567890' }).counterparty!;
    assert.match(out, /^[0-9a-f]{32}$/);
    assert.equal(out.includes('acct'), false);
    assert.equal(out.includes('1234'), false);
  });

  test('nothing declared blinds to nothing', () => {
    assert.deepEqual(blind('ws_a', undefined), {});
    assert.deepEqual(blind('ws_a', null), {});
    assert.deepEqual(blind('ws_a', {}), {});
  });
});

describe('what it refuses', () => {
  const bad: Array<[string, unknown]> = [
    ['an array', ['a']],
    ['a string', 'counterparty'],
    ['a non-string value', { counterparty: 42 }],
    ['an empty value', { counterparty: '' }],
    ['an overlong value', { counterparty: 'x'.repeat(257) }],
    ['a name with a space', { 'counter party': 'x' }],
    ['a name starting with a digit', { '1st': 'x' }],
    ['a name with punctuation', { 'counter-party': 'x' }],
    ['an uppercase name', { Counterparty: 'x' }],
  ];
  for (const [what, value] of bad) {
    test(`${what} is refused`, () => {
      assert.throws(() => blind('ws_a', value), (e: { status?: number }) => e.status === 400);
    });
  }

  test(`more than ${MAX_DIMENSIONS} is refused`, () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_DIMENSIONS; i += 1) many[`d${i}`] = 'v';
    assert.throws(() => blind('ws_a', many), (e: { status?: number }) => e.status === 400);
  });

  test('a name at the length limit is still accepted', () => {
    const name = 'a'.repeat(32);
    assert.ok(blind('ws_a', { [name]: 'v' })[name]);
    assert.throws(() => blind('ws_a', { ['a'.repeat(33)]: 'v' }));
  });
});

describe('matching', () => {
  test('an operator who knows the value can confirm it; anyone else cannot', () => {
    const stored = blind('ws_a', { counterparty: 'acct_1' }).counterparty!;
    assert.equal(matches('ws_a', 'counterparty', 'acct_1', stored), true);
    assert.equal(matches('ws_a', 'counterparty', 'acct_2', stored), false);
    assert.equal(matches('ws_b', 'counterparty', 'acct_1', stored), false,
      'and not from another workspace, even knowing the value');
  });

  test('a malformed stored value does not throw', () => {
    assert.equal(matches('ws_a', 'counterparty', 'acct_1', ''), false);
    assert.equal(matches('ws_a', 'counterparty', 'acct_1', 'short'), false);
  });
});

describe('scope keys', () => {
  test('a scope names its dimension, so a refusal can say which ceiling it was', () => {
    const b = blind('ws_a', { counterparty: 'acct_1' }).counterparty!;
    assert.equal(scopeForDimension('counterparty', b), `dim:counterparty:${b}`);
  });

  test('a dimension scope cannot collide with a built-in one', () => {
    const b = blind('ws_a', { workspace: 'x' }).workspace!;
    const scope = scopeForDimension('workspace', b);
    for (const builtin of ['workspace', `key:${b}`, `type:${b}`]) {
      assert.notEqual(scope, builtin,
        'a caller-named dimension must not be able to address the workspace ceiling');
    }
  });
});
