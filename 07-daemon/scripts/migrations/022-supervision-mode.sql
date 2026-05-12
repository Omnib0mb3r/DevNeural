-- EVENT-DRIVEN-SUPERVISION.md step 1. Per-anchor supervision toggle.
--
-- 'polling' (default) preserves the legacy cron-driven Lex
-- supervision; 'event' opts the anchor in to daemon-driven event
-- pushes; 'off' disables both. SQLite can't add a CHECK constraint
-- to an existing column via ALTER, so we add the column with a
-- text default and the application layer enforces the enum on
-- write.

ALTER TABLE project_session
  ADD COLUMN supervision_mode TEXT NOT NULL DEFAULT 'polling';

CREATE INDEX IF NOT EXISTS idx_project_session_supervision
  ON project_session (supervision_mode);
