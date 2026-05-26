-- LEX-AUTONOMY codex item 5: sync barrier + freshness metadata in
-- cold-start preload.
--
-- Adds latest_chunk_ms to lex_transcript_ref so each per-session
-- distillation row carries the timestamp of the most recent chunk
-- that contributed to (or is missing from) its summary. Cold-start
-- preload compares latest_chunk_ms against ref_summary_ms to derive
-- staleness:
--
--   latest_chunk_ms > ref_summary_ms       -> stale (new chunks
--                                             since last distill)
--   latest_chunk_ms IS NOT NULL AND
--     ref_summary_ms IS NULL               -> stale (never distilled
--                                             but chunks exist)
--   otherwise                              -> fresh
--
-- Stage 5 of the spec wires the writer (brainstorm-jsonl-ingestor +
-- session-end pipeline) so live writes keep this column current; the
-- backfill below stamps existing rows from the chunks table so the
-- column is populated on day-one for the audit panel.
--
-- Nullable. NULL means "unknown / no chunks observed yet"; preload
-- treats NULL as fresh so we never falsely flag a brand-new ref as
-- stale before the ingestor has even ticked.

ALTER TABLE lex_transcript_ref ADD COLUMN latest_chunk_ms INTEGER;

-- Backfill: for every existing ref, set latest_chunk_ms to the
-- chunks table's MAX(created_at) under the matching cc_session_id.
-- created_at is ISO TEXT; julianday()-based conversion produces UTC
-- ms compatible with Date.now() values written by the live path.
-- Refs with no matching chunks (NULL cc_session_id pre-Stage 0, or
-- sessions that never produced a turn) stay NULL.
UPDATE lex_transcript_ref
   SET latest_chunk_ms = (
     SELECT CAST((julianday(MAX(created_at)) - 2440587.5) * 86400000 AS INTEGER)
       FROM brainstorm_chunks
      WHERE brainstorm_chunks.cc_session_id = lex_transcript_ref.cc_session_id
   )
 WHERE EXISTS (
   SELECT 1 FROM brainstorm_chunks
    WHERE brainstorm_chunks.cc_session_id = lex_transcript_ref.cc_session_id
 );

-- Index supports the cold-start preload's per-anchor scan: "find every
-- ref under this lex_session whose latest_chunk_ms beats its
-- ref_summary_ms". The shape mirrors idx_lex_transcript_ref_summary_ms
-- from migration 037 so both queries hit a hot index.
CREATE INDEX IF NOT EXISTS idx_lex_transcript_ref_latest_chunk_ms
  ON lex_transcript_ref(cc_session_id, latest_chunk_ms);
