// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/**
 * What the worker needs before it starts working.
 *
 * The worker sets MIGRATE_ON_BOOT=false and defers to the API, so on a deploy
 * that introduces a table it can start its loops before the migration lands.
 * Staging caught it, twenty seconds apart:
 *
 *   18:42:30  worker: reconciliation-due failed — relation ... does not exist
 *   18:42:50  api:    migrated 037_scheduled_reconciliation.sql
 *
 * A failed tick leaves last_ok_at NULL, so the loop reads as stalled until its
 * NEXT tick — an hour, for the hourly ones. The deploy gate refused to promote
 * the build, which is exactly what it is for.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

describe('the worker waits for the schema it was built against', () => {
  const main = read('src/worker/main.ts');

  test('it waits before registering any loop', () => {
    const wait = main.indexOf('await awaitSchema()');
    const firstLoop = main.indexOf("loop('lease-sweep'");
    assert.ok(wait > -1, 'the worker must wait for the schema it expects');
    assert.ok(firstLoop > -1);
    assert.ok(wait < firstLoop,
      'waiting after the loops are registered would not prevent anything');
  });

  test('the wait is bounded and starts anyway', () => {
    assert.match(main, /starting without the expected schema/,
      'a worker that refuses to expire leases because a migration never came '
      + 'has turned a deploy-ordering nuisance into an outage');
  });

  test('it checks the newest migration this image actually carries', () => {
    assert.match(main, /schema_migrations WHERE name = \$1/);
    assert.match(main, /readdir/, 'the expectation comes from the image, not a constant');
  });
});

/**
 * `cp -r src dest` copies src INTO dest when dest already exists. The build did
 * exactly that, so a rebuilt dist held dist/db/migrations/migrations/ with all
 * the files and a stale 001_init.sql at the top. Docker never saw it — its build
 * stage starts clean and the Dockerfile copies the migrations a second time —
 * but every local rebuild was wrong, and awaitSchema now reads that directory.
 */
describe('the build is idempotent', () => {
  const pkg = JSON.parse(read('package.json'));

  test('a rebuild cannot nest the migrations inside themselves', () => {
    assert.match(pkg.scripts.build, /rm -rf dist\/db\/migrations/,
      'without removing it first, cp -r nests on the second build');
  });

  test('and if a dist is present, it is flat and complete', () => {
    const dist = new URL('dist/db/migrations/', root);
    if (!existsSync(dist)) return;                       // nothing built here yet
    const built = readdirSync(dist).filter((f) => f.endsWith('.sql'));
    const src = readdirSync(new URL('src/db/migrations/', root))
      .filter((f) => f.endsWith('.sql'));
    assert.equal(existsSync(new URL('migrations/', dist)), false,
      'dist/db/migrations/migrations/ is the nesting bug');
    assert.equal(built.length, src.length,
      `dist has ${built.length} migrations, src has ${src.length}`);
  });

  test('the image also copies them directly, which is why production was spared', () => {
    assert.match(read('Dockerfile'), /COPY .*src\/db\/migrations \.\/dist\/db\/migrations/,
      'this line is what kept the nesting out of production — keep it');
  });
});
