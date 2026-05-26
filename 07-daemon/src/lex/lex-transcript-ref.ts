/**
 * lex_transcript_ref helpers (LEX-AUTONOMY codex item 5).
 *
 * isRefStale + the staleness derivation rules. Pure module so tests
 * + cold-start preload + dashboard panels can share one implementation
 * and never disagree on the staleness predicate.
 *
 * Rules (also documented in migration 041 + the investigation doc
 * docs/bugs/2026-05-26-lex-autonomy-codex5-sync-barrier-investigation.md):
 *
 *   latest_chunk_ms IS NULL                  -> fresh (no chunks
 *                                               observed yet on this
 *                                               cc_session, nothing
 *                                               to be stale against)
 *   latest_chunk_ms set, ref_summary_ms null -> stale (chunks exist
 *                                               but never distilled)
 *   latest_chunk_ms > ref_summary_ms         -> stale (new chunks
 *                                               landed after the
 *                                               last distill)
 *   latest_chunk_ms <= ref_summary_ms        -> fresh
 *
 * The "latest_chunk_ms null" -> fresh branch is deliberate: a
 * just-bound ref before its first ingestor tick should not be
 * flagged stale; the cold-start preamble would render an alarm pill
 * on every brand-new anchor otherwise. The migration's backfill
 * stamps existing rows so this case is rare in production after the
 * first tick on a live anchor.
 */
import type { LexTranscriptRefRow } from '../store/index-db.js';

export function isRefStale(ref: LexTranscriptRefRow): boolean {
  if (ref.latest_chunk_ms === null) return false;
  if (ref.ref_summary_ms === null) return true;
  return ref.latest_chunk_ms > ref.ref_summary_ms;
}

/* Bucket counts a preload needs for its audit row + header pill.
 * Pure derivation over an array of refs. */
export interface RefStalenessCounts {
  total: number;
  stale: number;
  fresh: number;
}

export function summarizeRefStaleness(
  refs: LexTranscriptRefRow[],
): RefStalenessCounts {
  let stale = 0;
  for (const r of refs) if (isRefStale(r)) stale += 1;
  return {
    total: refs.length,
    stale,
    fresh: refs.length - stale,
  };
}
