-- Curator-loop revival (R3): pre-injection vet gate needs a third
-- curator_log.decision value, 'vetoed', for candidates that passed the
-- cosine floor but were rejected by the LLM judge (DEVNEURAL_CURATOR_VET).
--
-- curator_log.decision carries a CHECK (decision IN ('inject','silence')),
-- so this is not a no-op case: SQLite cannot ALTER a CHECK constraint in
-- place, so the table is rebuilt and rows are copied verbatim (same
-- pattern as migration 040).
--
-- curator_signal.curator_log_id is a FK into curator_log(id) and the
-- migration runner connects with `PRAGMA foreign_keys = ON` (src/db/
-- migrate.ts): SQLite performs an implicit DELETE before DROP TABLE and
-- that delete fails with "FOREIGN KEY constraint failed" if any
-- curator_signal row still references a curator_log row. This is safe
-- today because curator_signal has zero writers in production (R2 of
-- the curator-loop revival wires the first ones); if that ever changes
-- before this migration ships, curator_signal needs the same
-- rebuild-and-copy treatment first.

CREATE TABLE curator_log_new (
  id           TEXT PRIMARY KEY,
  prompt_id    TEXT NOT NULL UNIQUE,
  session_id   TEXT,
  project_slug TEXT,
  decision     TEXT NOT NULL CHECK (decision IN ('inject','silence','vetoed')),
  page_slug    TEXT,
  score        REAL,
  threshold    REAL NOT NULL,
  confidence   REAL,
  source_class TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO curator_log_new
  (id, prompt_id, session_id, project_slug, decision, page_slug,
   score, threshold, confidence, source_class, created_at)
SELECT id, prompt_id, session_id, project_slug, decision, page_slug,
       score, threshold, confidence, source_class, created_at
  FROM curator_log;

DROP TABLE curator_log;
ALTER TABLE curator_log_new RENAME TO curator_log;

CREATE INDEX IF NOT EXISTS curator_log_day ON curator_log(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS curator_log_prompt_uq
  ON curator_log(prompt_id);
