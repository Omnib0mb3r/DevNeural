-- Inject-verdict explicit LLM judge (2026-07-15): widen
-- curator_signal.source CHECK to accept 'llm-judge'.
--
-- DEVNEURAL_INJECT_VERDICT (default off) asks a local LLM directly
-- whether an assistant's reply actually used the injected context, as
-- an additive second opinion alongside the existing cosine-based
-- 'regex-inferred' HIT/correction inference (see
-- src/reinforcement/inject-verdict.ts). curator_signal.source carries
-- a CHECK (source IN ('regex-inferred','user-explicit',
-- 'dashboard-click')), so this is not a no-op case: SQLite cannot
-- ALTER a CHECK constraint in place, so the table is rebuilt and rows
-- are copied verbatim (same rebuild-and-copy pattern as migrations
-- 046-048).
--
-- Unlike migration 048's curator_log rebuild, curator_signal has no
-- child tables referencing it via FK, so dropping it here needs no
-- upstream cleanup even with PRAGMA foreign_keys = ON (the migration
-- runner's connection, src/db/migrate.ts).

CREATE TABLE curator_signal_new (
  id             TEXT PRIMARY KEY,
  curator_log_id TEXT NOT NULL,
  prompt_id      TEXT NOT NULL,
  signal         TEXT NOT NULL CHECK (signal IN ('hit','correction','click','wrong')),
  source         TEXT NOT NULL CHECK (source IN ('regex-inferred','user-explicit','dashboard-click','llm-judge')),
  weight         REAL NOT NULL DEFAULT 1.0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (curator_log_id) REFERENCES curator_log(id)
);

INSERT INTO curator_signal_new
  (id, curator_log_id, prompt_id, signal, source, weight, created_at)
SELECT id, curator_log_id, prompt_id, signal, source, weight, created_at
  FROM curator_signal;

DROP TABLE curator_signal;
ALTER TABLE curator_signal_new RENAME TO curator_signal;

CREATE INDEX IF NOT EXISTS curator_signal_log
  ON curator_signal(curator_log_id);
CREATE INDEX IF NOT EXISTS curator_signal_prompt
  ON curator_signal(prompt_id);
