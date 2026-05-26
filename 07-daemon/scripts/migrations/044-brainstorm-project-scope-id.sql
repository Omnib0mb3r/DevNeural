-- LEX-AUTONOMY codex item 12 (Fix 49): project_scope_id on
-- brainstorm_sessions. Replaces the brittle label-match grouping with
-- an explicit scope token. NULL = ungrouped (legacy rows + new rows
-- that have not been scoped yet); preload falls back to label-match
-- when scope is NULL on either side.
--
-- Backfill: rows with supervises_project_anchor_id set inherit that
-- anchor id as their project_scope_id. Rows without supervisor
-- binding stay NULL.

ALTER TABLE brainstorm_sessions ADD COLUMN project_scope_id TEXT;

UPDATE brainstorm_sessions
   SET project_scope_id = supervises_project_anchor_id
 WHERE supervises_project_anchor_id IS NOT NULL
   AND project_scope_id IS NULL;

CREATE INDEX IF NOT EXISTS ix_brainstorm_project_scope_started
  ON brainstorm_sessions(project_scope_id, started_ms DESC)
  WHERE project_scope_id IS NOT NULL;
