-- 2026-09-30 BUG-060: lex_session.title / derived_title are the one
-- canonical brainstorm name; brainstorm_sessions.user_label /
-- derived_label are a copy written only by setLexSessionTitle. Renames
-- before this fix reached lex_session alone, so copy the canonical name
-- over any row that drifted. Rows with no lex_session (standalone,
-- audit-doc) keep their own label.
UPDATE brainstorm_sessions
   SET user_label = (SELECT l.title FROM lex_session l WHERE l.id = brainstorm_sessions.id)
 WHERE EXISTS (
   SELECT 1 FROM lex_session l
    WHERE l.id = brainstorm_sessions.id
      AND l.title IS NOT NULL
      AND l.title <> COALESCE(brainstorm_sessions.user_label, '')
 );
UPDATE brainstorm_sessions
   SET derived_label = (SELECT l.derived_title FROM lex_session l WHERE l.id = brainstorm_sessions.id)
 WHERE EXISTS (
   SELECT 1 FROM lex_session l
    WHERE l.id = brainstorm_sessions.id
      AND l.derived_title IS NOT NULL
      AND l.derived_title <> COALESCE(brainstorm_sessions.derived_label, '')
 );
