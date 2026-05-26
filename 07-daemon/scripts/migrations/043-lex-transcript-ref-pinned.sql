-- LEX-AUTONOMY codex item 7 (Fix 44): pinned column on lex_transcript_ref.
--
-- Stores the operator's explicit "always include this ref in cold-start
-- preload" intent. The adaptive walk-back scorer uses pinned=1 as a
-- pin-prepass bonus that forces inclusion ahead of recency / freshness
-- ranking. POST /lex/refs/:cc_session_id/pin flips the bit; the audit
-- row lands in cross_session_injection_log with caller_label='ref-pin'.
--
-- Codex 11 (grooming surface) will likely expose a dashboard UI for
-- pin/unpin; codex 7 ships the storage + scorer + a curl-friendly route.
--
-- Additive nullable in spirit; SQLite ALTER TABLE ADD COLUMN with a
-- constant DEFAULT 0 sets every existing row to 0 transactionally so
-- the column is NOT NULL safe without backfill noise.

ALTER TABLE lex_transcript_ref
  ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

-- Partial index keyed on the pinned bit so the scorer's "fetch pinned
-- refs first" pre-pass is one b-tree seek rather than a full scan.
CREATE INDEX IF NOT EXISTS idx_lex_transcript_ref_pinned
  ON lex_transcript_ref(lex_session_id, pinned) WHERE pinned = 1;
