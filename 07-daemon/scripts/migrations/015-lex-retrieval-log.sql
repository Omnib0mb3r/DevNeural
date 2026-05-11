-- Wave 3 Lane B step 34 (LX-12a). lex_retrieval_log table.
--
-- Records every retrieval decision Lex makes so the dashboard can show
-- a trace of what was searched and whether internal or external retrieval
-- was used. Written by chunk_search, /lex/recall hooks, and the tool gate
-- middleware. The `decision` field captures what Lex was told to do next
-- (internal-ok / weak-fallthrough / gate-blocked / web-allowed).

CREATE TABLE IF NOT EXISTS lex_retrieval_log (
  id            TEXT PRIMARY KEY,
  brainstorm_id TEXT,
  ts            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  query         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('grep','chunks','wiki','web')),
  results_json  TEXT,
  decision      TEXT
);

CREATE INDEX IF NOT EXISTS lex_retrieval_log_brainstorm
  ON lex_retrieval_log(brainstorm_id, ts DESC);
CREATE INDEX IF NOT EXISTS lex_retrieval_log_recent
  ON lex_retrieval_log(ts DESC);
CREATE INDEX IF NOT EXISTS lex_retrieval_log_kind
  ON lex_retrieval_log(kind, ts DESC);
