-- CI-1, CI-2: Curator decisions and follow-up signals.
--
-- curator_log records every inject-or-silence decision with the
-- decision metadata and the prompt_id correlation token. The
-- prompt_id UNIQUE constraint allows external callers to pass it as
-- a stable correlation key while the FK in curator_signal uses the
-- internal id (SQLite valid parent-key referencing).

CREATE TABLE IF NOT EXISTS curator_log (
  id           TEXT PRIMARY KEY,
  prompt_id    TEXT NOT NULL UNIQUE,
  session_id   TEXT,
  project_slug TEXT,
  decision     TEXT NOT NULL CHECK (decision IN ('inject','silence')),
  page_slug    TEXT,
  score        REAL,
  threshold    REAL NOT NULL,
  confidence   REAL,
  source_class TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS curator_log_day ON curator_log(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS curator_log_prompt_uq
  ON curator_log(prompt_id);

-- Hits, corrections, and click-throughs that follow a curator decision.
CREATE TABLE IF NOT EXISTS curator_signal (
  id             TEXT PRIMARY KEY,
  curator_log_id TEXT NOT NULL,
  prompt_id      TEXT NOT NULL,
  signal         TEXT NOT NULL CHECK (signal IN ('hit','correction','click','wrong')),
  source         TEXT NOT NULL CHECK (source IN ('regex-inferred','user-explicit','dashboard-click')),
  weight         REAL NOT NULL DEFAULT 1.0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (curator_log_id) REFERENCES curator_log(id)
);

CREATE INDEX IF NOT EXISTS curator_signal_log
  ON curator_signal(curator_log_id);
CREATE INDEX IF NOT EXISTS curator_signal_prompt
  ON curator_signal(prompt_id);
