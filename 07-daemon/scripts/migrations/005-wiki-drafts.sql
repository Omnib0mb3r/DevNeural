-- BF-7: Pending wiki drafts produced by automatic session-end
-- distillation. Awaiting promote / edit / discard by the user.
--
-- Per CODEX-REVIEW-002 B4, the brainstorm_id column is semantically a
-- voice-session FK. The column name is retained for compatibility and
-- accepts both kind='brainstorm' (the default path, BF-7) and
-- kind='meeting' (the explicit POST /meetings/:id/promote-to-wiki path,
-- BF-15).
--
-- Auto-promote is disabled in Wave 1 per section 3.4. Auto-drop runs
-- as a daily scheduled job introduced by 07-daemon/src/scheduler.ts.

CREATE TABLE IF NOT EXISTS wiki_drafts (
  id            TEXT PRIMARY KEY,
  brainstorm_id TEXT NOT NULL,
  page_slug     TEXT NOT NULL,
  page_title    TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  confidence    REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status        TEXT NOT NULL CHECK (status IN ('pending','promoted','discarded','auto-promoted','auto-dropped','superseded')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at   TEXT,
  resolved_by   TEXT,
  FOREIGN KEY (brainstorm_id) REFERENCES brainstorm_sessions(id)
);

CREATE INDEX IF NOT EXISTS wiki_drafts_status
  ON wiki_drafts(status, created_at);
CREATE INDEX IF NOT EXISTS wiki_drafts_session
  ON wiki_drafts(brainstorm_id);
