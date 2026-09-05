-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Deimos LLC
-- Proof that the worker is not merely alive, but actually working.
--
-- The worker must be long-running: it expires leases on a timer whether or not
-- a request is in flight. If it stops, leases never expire, effects stay
-- `pending` forever, and every retry is told `in_flight` — indefinitely, and
-- silently. Nothing detected that.
--
-- A crash is the easy case; the platform restarts it. The dangerous case is a
-- wedge: the process alive and healthy-looking while one loop is stuck inside a
-- query that never returns. Its `busy` flag stays set and that loop simply never
-- runs again, with no error and no exit.
--
-- So the heartbeat records per LOOP, not per process, and records the last
-- successful completion rather than the last attempt. A loop that starts and
-- never finishes goes stale, which is exactly what needs to be visible.
--
-- One row per loop name, not per instance: several replicas are safe by design
-- and any healthy one keeps the row fresh, which is the right meaning — "this
-- work is being done by someone".
--
-- No foreign key here either; this table is written on every worker tick and
-- belongs to no workspace.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  loop_name            text        PRIMARY KEY,
  instance             text        NOT NULL,
  interval_ms          integer     NOT NULL,
  last_ok_at           timestamptz,
  last_error           text,
  consecutive_failures integer     NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
