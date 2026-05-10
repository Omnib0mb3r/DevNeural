-- LX-5: Inline thumbs UI on every Lex turn writes here. The
-- prompt_version column lets the prompt loop (LX-1) aggregate
-- thumb-up rate per SYSTEM_PROMPT_VERSION over weeks.

CREATE TABLE IF NOT EXISTS lex_feedback (
  id             TEXT PRIMARY KEY,
  turn_id        TEXT NOT NULL,
  brainstorm_id  TEXT,
  prompt_version TEXT NOT NULL,
  vote           TEXT NOT NULL CHECK (vote IN ('up','down')),
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS lex_feedback_version
  ON lex_feedback(prompt_version);
CREATE INDEX IF NOT EXISTS lex_feedback_session
  ON lex_feedback(brainstorm_id);
