-- BF-6, BF-11, BF-14, BF-17, plus CODEX-REVIEW-002 B5 additions.
--
-- Existing brainstorm_sessions schema (index-db.ts) does NOT carry
-- project_slug at all. It associates project via cwd + pty_id +
-- claude_session_id. PHASE-TWO-DAY-1-VERIFICATIONS.md Q-9 records the
-- finding. This migration adds project_slug as a new nullable column
-- (matches BF-6 spec); legacy rows stay null and surface under
-- 'general' per the section 4.1 response shape.
--
-- All new columns are additive. Meeting code paths do not light up
-- until Wave 2 day 5; the columns ship now to keep migration ordering
-- clean.

ALTER TABLE brainstorm_sessions ADD COLUMN project_slug     TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN audio_path       TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN distilled_at     TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN kind             TEXT NOT NULL DEFAULT 'brainstorm';
ALTER TABLE brainstorm_sessions ADD COLUMN attendees        TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN meeting_topic    TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN consent_acked    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brainstorm_sessions ADD COLUMN consent_acked_at TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN consent_acked_by TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN keep_audio       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brainstorm_sessions ADD COLUMN provenance       TEXT NOT NULL DEFAULT 'voice';

-- SQLite ALTER TABLE cannot add CHECK after the fact; the runner
-- enforces the kind and provenance domains in code (see
-- src/lex/session-end-pipeline.ts and src/dashboard/sessions-create.ts).
-- Additions to either domain require updating both call sites and
-- the spec sections 3.3 and 3.10.

CREATE INDEX IF NOT EXISTS brainstorm_sessions_kind
  ON brainstorm_sessions(kind, started_ms DESC);
CREATE INDEX IF NOT EXISTS brainstorm_sessions_project_slug
  ON brainstorm_sessions(project_slug);
CREATE INDEX IF NOT EXISTS brainstorm_sessions_provenance
  ON brainstorm_sessions(provenance);
