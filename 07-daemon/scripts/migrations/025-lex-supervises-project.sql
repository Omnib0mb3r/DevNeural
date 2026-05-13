-- Brainstorm-to-project binding (Phase C).
--
-- Adds a persistent supervises_project_anchor_id column on
-- lex_session so each Lex brainstorm row carries the project anchor
-- it is supervising. The cross-session-inject fallback resolver uses
-- this to pick a target_session when Lex omits one, removing the
-- judgment call from live_state.open_projects.
--
-- NULL is the unbound state; non-null references project_session(id).
-- ON DELETE SET NULL so dropping a project anchor downgrades any
-- pointing Lex row to unbound rather than cascading the Lex row away.

ALTER TABLE lex_session
  ADD COLUMN supervises_project_anchor_id TEXT
    REFERENCES project_session(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lex_session_supervises
  ON lex_session (supervises_project_anchor_id);
