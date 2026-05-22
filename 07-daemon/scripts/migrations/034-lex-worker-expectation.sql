-- Brainstorm-as-durable-primary-entity (2026-05-22, plan section L).
-- Active polling-with-expectations supervisor table.
--
-- When the brainstorm dispatches a task to its attached worker CC,
-- Lex stores a structured expectation row. The expectation-supervisor
-- ticks every 90s, walks open rows, reads the recent worker jsonl
-- tail, and asks the LLM "does the worker's recent activity align
-- with expected_outcome X?". On drift the supervisor fires a
-- lex-attention event so Lex can inject a correction on the next
-- voice turn.
--
-- The closed_reason CHECK encodes the four resolution paths:
--   completed    expectation met; worker accomplished expected_outcome
--   drifted      worker is doing something else; Lex must correct
--   superseded   Lex changed direction; this expectation no longer
--                applies
--   cancelled    operator dismissed the expectation manually

CREATE TABLE IF NOT EXISTS lex_worker_expectation (
  id                  TEXT PRIMARY KEY,
  brainstorm_id       TEXT NOT NULL,
  anchor_id           TEXT NOT NULL,
  expected_outcome    TEXT NOT NULL,
  expected_files      TEXT NOT NULL DEFAULT '[]',
  expected_duration_ms INTEGER,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at           TEXT,
  closed_reason       TEXT CHECK(closed_reason IN (
                        'completed',
                        'drifted',
                        'superseded',
                        'cancelled'
                      )),
  last_evaluated_at   TEXT,
  last_alignment_score REAL,
  last_drift_summary  TEXT,
  last_suggested_correction TEXT
);

CREATE INDEX IF NOT EXISTS idx_lex_worker_expectation_open
  ON lex_worker_expectation (closed_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lex_worker_expectation_brainstorm
  ON lex_worker_expectation (brainstorm_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lex_worker_expectation_anchor
  ON lex_worker_expectation (anchor_id, closed_at);
