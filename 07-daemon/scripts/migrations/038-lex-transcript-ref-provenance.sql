-- Stage 2 of LEX-AUTONOMY-PAYLOAD-SPEC.md.
--
-- Provenance fields on the per-CC-session distillation row.
-- Stage 0 introduced ref_summary + ref_summary_ms (the artifact and
-- its write timestamp). Stage 2 introduces the columns that make the
-- artifact debuggable + comparable:
--
--   source_chunk_count  INTEGER  how many brainstorm_chunks rows fed
--                                 the distillation. Equals what was
--                                 actually sent to the LLM after the
--                                 chunkLimit + maxTranscriptBytes
--                                 caps; not the universe of chunks
--                                 the session produced.
--   source_session_ids  TEXT     JSON array of cc_session_id strings
--                                 the summary covers. For a per-ref
--                                 ref_summary this is always a single
--                                 id (the ref's own cc_session_id),
--                                 stored as a JSON array for shape
--                                 symmetry with the rolling aggregate
--                                 path on brainstorm_sessions.
--   coverage_score      REAL     0..1 fraction of the session's chunks
--                                 that fit in the prompt. Computed as
--                                 source_chunk_count / total_chunks_in
--                                 _session at write time. The CHECK
--                                 keeps invalid floats out at the DB
--                                 layer so a buggy writer can't
--                                 silently land 1.42 or -0.3.
--
-- All three nullable. Legacy refs (pre-Stage 2) and refs whose
-- distillation has not yet run will be NULL. Cold-start preload +
-- dashboard reads must tolerate NULL.

ALTER TABLE lex_transcript_ref ADD COLUMN source_chunk_count INTEGER;
ALTER TABLE lex_transcript_ref ADD COLUMN source_session_ids TEXT;
ALTER TABLE lex_transcript_ref ADD COLUMN coverage_score REAL
  CHECK (coverage_score IS NULL OR (coverage_score >= 0 AND coverage_score <= 1));
