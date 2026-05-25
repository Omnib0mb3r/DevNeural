-- Stage 0 of LEX-AUTONOMY-PAYLOAD-SPEC.md.
--
-- Per-CC-session attribution at the brainstorm_chunks row level.
-- Today every chunk under an anchor is summed flat into one
-- anchor.last_summary, which cannot represent topic shifts across
-- sessions. Stamping cc_session_id at insert time is the foundation
-- for Stage 2's per-session distillation (each lex_transcript_ref
-- gets its own ref_summary scoped by cc_session_id).
--
-- Nullable on purpose:
--   - Historical rows stay NULL (no backfill in this stage). Stage 2
--     distillation falls back to anchor-flat behavior when every
--     relevant row for a session is NULL.
--   - Direct-LLM ingestion paths (no CC session bound) write NULL.
--
-- Composite index matches the Stage 2 read pattern:
-- WHERE brainstorm_id = ? AND cc_session_id = ? ORDER BY turn_index.
-- The existing (brainstorm_id, turn_index) index stays in place for
-- the legacy full-transcript walk that powers backfill + reaper.

ALTER TABLE brainstorm_chunks ADD COLUMN cc_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_brainstorm_chunks_session
  ON brainstorm_chunks(brainstorm_id, cc_session_id, turn_index);
