-- Stage 0 of LEX-AUTONOMY-PAYLOAD-SPEC.md.
--
-- Per-CC-session distillation storage. Q2 of the spec: ref_summary is
-- the canonical, immutable summary for the ended session, written
-- once by session-end-pipeline. ref_summary_ms records when it was
-- written so cold-start preload can compare against
-- brainstorm_sessions.last_summary_ms for freshness signaling.
--
-- Anchor-level brainstorm_sessions.last_summary stays as the rolling
-- aggregate (regenerated from the N most recent ref_summaries on
-- every session-end). The per-ref column is the source of truth; the
-- aggregate is derived.
--
-- Nullable: legacy refs (pre-Stage 2) and refs whose session-end
-- distillation has not yet completed will be NULL. Cold-start
-- preload treats NULL as "no per-session summary available" and
-- falls back to the anchor aggregate.
--
-- Stage 2 introduces the writer; this migration only allocates the
-- columns + an index for the freshness comparison query
-- (ref_summary_ms DESC scan to find newest summarized ref).

ALTER TABLE lex_transcript_ref ADD COLUMN ref_summary TEXT;
ALTER TABLE lex_transcript_ref ADD COLUMN ref_summary_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_lex_transcript_ref_summary_ms
  ON lex_transcript_ref(lex_session_id, ref_summary_ms DESC);
