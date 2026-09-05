// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos LLC
/** Mint an API key under an existing workspace, for local demos. */
import 'dotenv/config';
import { getPool, closePool } from '../src/db/pool.js';
import { createApiKey } from '../src/domain/auth.js';

const pool = getPool();
const { rows } = await pool.query<{ id: string; name: string }>(
  `SELECT id, name FROM workspaces ORDER BY created_at DESC LIMIT 1`);
if (!rows[0]) throw new Error('no workspace exists');
const k = await createApiKey(pool, rows[0].id, `demo-${Date.now()}`,
  ['effects:begin', 'effects:report', 'effects:read'], null);
console.error(`workspace: ${rows[0].name}`);
console.log((k as any).plaintext ?? (k as any).key);
await closePool();
