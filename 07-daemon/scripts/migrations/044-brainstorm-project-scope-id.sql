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

-- supervises_project_anchor_id lives on lex_session (migration 025),
-- not brainstorm_sessions. Per migration 018 contract, lex_session.id
-- = brainstorm_sessions.id for the same anchor; JOIN drives the
-- backfill across the two tables.
UPDATE brainstorm_sessions
   SET project_scope_id = (
     SELECT supervises_project_anchor_id
       FROM lex_session
      WHERE lex_session.id = brainstorm_sessions.id
        AND supervises_project_anchor_id IS NOT NULL
   )
 WHERE project_scope_id IS NULL
   AND EXISTS (
     SELECT 1 FROM lex_session
      WHERE lex_session.id = brainstorm_sessions.id
        AND supervises_project_anchor_id IS NOT NULL
   );

CREATE INDEX IF NOT EXISTS ix_brainstorm_project_scope_started
  ON brainstorm_sessions(project_scope_id, started_ms DESC)
  WHERE project_scope_id IS NOT NULL;
