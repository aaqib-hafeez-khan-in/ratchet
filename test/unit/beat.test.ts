// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain ES module served to the browser, no types.
import { beatFor } from '../../web/assets/beat.js';

/**
 * The scroll explainer's beat selection. Tested here because the animation
 * itself cannot run in a headless pane: requestAnimationFrame is paused while
 * the page is hidden and scroll events are not dispatched, so the arithmetic
 * that decides what a reader sees is verified directly instead.
 */
describe('scroll explainer beat selection', () => {
  const H = 3200;   // stage height, 400vh at an 800px viewport
  const V = 800;
  const N = 4;
  const at = (top: number) => beatFor(top, H, V, N);

  test('the first beat shows before the stage is scrolled', () => {
    assert.equal(at(0), 0);
    assert.equal(at(500), 0, 'stage still below the fold');
  });

  test('beats advance evenly through the scrollable range', () => {
    const scrollable = H - V;               // 2400
    assert.equal(at(-scrollable * 0.00), 0);
    assert.equal(at(-scrollable * 0.20), 0);
    assert.equal(at(-scrollable * 0.30), 1);
    assert.equal(at(-scrollable * 0.55), 2);
    assert.equal(at(-scrollable * 0.80), 3);
  });

  test('the last beat holds at and past the end — never out of range', () => {
    const scrollable = H - V;
    assert.equal(at(-scrollable), N - 1, 'exactly at the end');
    assert.equal(at(-scrollable * 2), N - 1, 'scrolled well past');
    assert.equal(at(-999999), N - 1);
  });

  test('progress is clamped, so scrolling back up never goes negative', () => {
    assert.equal(at(50), 0);
    assert.equal(at(10_000), 0);
  });

  test('a stage shorter than the viewport does not divide by zero', () => {
    assert.equal(beatFor(-100, 400, 800, 4), 0);
    assert.equal(beatFor(-100, 800, 800, 4), 0, 'exactly equal is also unscrollable');
  });

  test('every beat is reachable — none is skipped', () => {
    const scrollable = H - V;
    const reached = new Set<number>();
    for (let i = 0; i <= 200; i++) reached.add(at(-scrollable * (i / 200)));
    assert.deepEqual([...reached].sort(), [0, 1, 2, 3],
      'a beat nobody can land on is a beat nobody reads');
  });

  test('degenerate beat counts are handled', () => {
    assert.equal(beatFor(-1200, H, V, 1), 0);
    assert.equal(beatFor(-1200, H, V, 0), 0);
  });
});
