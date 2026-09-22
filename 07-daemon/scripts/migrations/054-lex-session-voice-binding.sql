-- 2026-09-21 voice layers (docs/spec/LAYER-1-CONTROL.md, "Scope: one L1
-- per brainstorm"): persist the Layer 1 (voice brain) binding on the
-- brainstorm anchor so a daemon restart, the dashboard and the Stream
-- Deck can find the L1 session the same way project_session carries the
-- worker binding. NULL = no voice session spawned for this anchor.
ALTER TABLE lex_session ADD COLUMN voice_session_id TEXT;
ALTER TABLE lex_session ADD COLUMN voice_pty_id TEXT;
ALTER TABLE lex_session ADD COLUMN voice_spawned_ms INTEGER;
