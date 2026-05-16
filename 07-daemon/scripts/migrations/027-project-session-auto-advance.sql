-- Autonomous supervisor phase 3.
--
-- Per-anchor auto-advance lease + monotonically increasing epoch so
-- the loop can fence its own writes against a daemon restart or a
-- second supervisor process. SQLite can't add a CHECK constraint to
-- an existing column via ALTER, so we add bare TEXT/INTEGER columns
-- and the application layer enforces semantics on read/write.

ALTER TABLE project_session
  ADD COLUMN auto_advance_owner TEXT;

ALTER TABLE project_session
  ADD COLUMN auto_advance_epoch INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_project_session_auto_advance
  ON project_session (auto_advance_owner, auto_advance_epoch);
