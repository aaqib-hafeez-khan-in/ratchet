// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/** Writes the OpenAPI document to disk. Generated from the live route schemas. */
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/api/app.js';
import { closePool } from '../src/db/pool.js';

const app = await buildApp({ logger: false });
await app.ready();
const spec = app.swagger();
await writeFile('openapi.json', `${JSON.stringify(spec, null, 2)}\n`);
const paths = Object.keys((spec as { paths: Record<string, unknown> }).paths).length;
console.log(`wrote openapi.json — ${paths} paths`);
await app.close();
await closePool();
