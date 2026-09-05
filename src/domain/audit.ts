// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import type { Db } from '../db/pool.js';

export async function audit(
  db: Db, workspaceId: string, action: string, actor: string,
  subjectId: string | null, detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (workspace_id, action, actor, subject_id, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [workspaceId, action, actor, subjectId, JSON.stringify(detail)],
  );
}

export async function listAudit(db: Db, workspaceId: string, limit = 50) {
  const { rows } = await db.query(
    `SELECT action, actor, subject_id, detail, created_at
       FROM audit_events WHERE workspace_id = $1 ORDER BY id DESC LIMIT $2`,
    [workspaceId, Math.min(limit, 200)],
  );
  return rows.map((r) => ({
    action: r.action, actor: r.actor, subjectId: r.subject_id,
    detail: r.detail, createdAt: r.created_at.toISOString(),
  }));
}
