-- Migration 039: worker_event_diagnostic_log.
--
-- Per-stage instrumentation for the event-driven Lex supervisor
-- pipeline (EVENT-DRIVEN-SUPERVISION.md). Fix 34 was raised because
-- the wire delivered zero rows to cross_session_injection_log
-- despite supervision_mode='event' anchors being live. Without
-- per-stage rows the dead branch could not be located by static
-- inspection. This table is append-only and intentionally low-cost
-- so the production instrumentation can stay on for one or two
-- failure modes after the fix lands (route.resolved /
-- inject.attempted / inject.result by default; the verbose
-- chokidar.* + detector.* + gate.* rows are gated behind
-- DEVNEURAL_SUPERVISOR_DEBUG=1).
--
-- stage is a free-form string (not a CHECK enum) so a future
-- pipeline stage can be added without a migration. Indexed on
-- (anchor_id, ts) and (stage, ts) for the dashboard stats endpoint
-- + tail queries.

CREATE TABLE IF NOT EXISTS worker_event_diagnostic_log (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  anchor_id   TEXT,
  stage       TEXT NOT NULL,
  verdict     TEXT,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS ix_wedl_ts           ON worker_event_diagnostic_log(ts);
CREATE INDEX IF NOT EXISTS ix_wedl_stage_ts     ON worker_event_diagnostic_log(stage, ts);
CREATE INDEX IF NOT EXISTS ix_wedl_anchor_ts    ON worker_event_diagnostic_log(anchor_id, ts);
