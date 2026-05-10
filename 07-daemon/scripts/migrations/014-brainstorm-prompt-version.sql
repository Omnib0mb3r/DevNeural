-- LX-5 wiring (carry-over #1): each Lex spawn snapshots its system-
-- prompt version (hash from buildLexSystemPromptVersioned) onto the
-- bound brainstorm_sessions row so downstream surfaces (LexThumbs,
-- voice WS assistant-text, /lex/sessions) can attach the version to
-- per-turn feedback without re-resolving it.
--
-- NULL until the spawn route sets it; legacy rows stay NULL.

ALTER TABLE brainstorm_sessions ADD COLUMN prompt_version TEXT;
