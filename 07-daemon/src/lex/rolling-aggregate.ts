/**
 * Rolling aggregate writer for brainstorm_sessions.last_summary.
 *
 * Stage 2 of LEX-AUTONOMY-PAYLOAD-SPEC.md. The anchor-level
 * last_summary is no longer authored by an LLM call; it is composed
 * deterministically from the N newest ref_summary rows on
 * lex_transcript_ref. Each ref_summary covers ONE CC session; the
 * aggregate stitches the most recent N together with a session
 * separator so the cold-start preload + dashboard surfaces see a
 * coherent multi-session view without paying for a second LLM pass.
 *
 * Contract per Codex review:
 *   - N = 3 newest per-session artifacts (configurable via opts.n).
 *   - Newest-first order in the rendered text (most recent session
 *     at the top so cold-start preamble surfaces "what just
 *     happened" first).
 *   - Hard char cap (8000) on the concatenated output. The cap
 *     applies after the concat + separators, not per-ref, so a
 *     very long recent ref does not get its content silently
 *     truncated when older refs would otherwise fit.
 *   - No LLM. Pure string assembly. Stage 3+ may introduce a
 *     compressing pass; Stage 2 explicitly does not.
 *   - last_summary_ms = max(ref_summary_ms across the N rendered
 *     rows). Cold-start preload freshness compares this against
 *     the per-ref timestamps; using max() keeps it monotone.
 *
 * Returns null when no ref_summary rows exist (Stage 2 contract
 * N=0 aggregate handles empty cleanly): caller leaves
 * last_summary as-is and the cold-start preload falls through to
 * its existing null-summary handling.
 */
import type { IndexDb, LexTranscriptRefRow } from '../store/index-db.js';

export interface RollingAggregateOptions {
  /** How many ref_summaries to stitch. Spec default 3. */
  n?: number;
  /** Hard character ceiling on the concatenated output. Spec
   * default 8000. The cap is applied after concat so the newest
   * sessions are preserved verbatim and older sessions get
   * truncated when budget runs out. */
  maxChars?: number;
}

export interface RollingAggregateResult {
  summary: string;
  /** max(ref_summary_ms across the N rendered rows). Used by the
   * caller to land brainstorm_sessions.last_summary_ms. */
  summary_ms: number;
  /** ids of the refs that fed the render (in order). */
  source_ref_ids: number[];
  /** cc_session_ids covered. Useful for provenance logging /
   * cold-start preload's "freshness across N sessions" surface. */
  source_session_ids: string[];
}

const DEFAULT_N = 3;
const DEFAULT_MAX_CHARS = 8000;
const SESSION_SEPARATOR =
  '\n\n---\n\n';

export function recomputeRollingAggregate(
  db: IndexDb,
  lexSessionId: string,
  opts: RollingAggregateOptions = {},
): RollingAggregateResult | null {
  const n = Math.max(0, opts.n ?? DEFAULT_N);
  const maxChars = Math.max(0, opts.maxChars ?? DEFAULT_MAX_CHARS);
  if (n === 0) return null;
  const refs = db.listRecentRefSummariesForLexSession(lexSessionId, n);
  if (refs.length === 0) return null;
  return renderAggregate(refs, maxChars);
}

/* Render is split from the query so tests + future callers (e.g. a
 * dashboard preview that wants to see what the aggregate WOULD say
 * without writing it) can drive it with synthetic rows. */
export function renderAggregate(
  refs: LexTranscriptRefRow[],
  maxChars: number,
): RollingAggregateResult | null {
  if (refs.length === 0) return null;
  const sessionIds: string[] = [];
  const refIds: number[] = [];
  let summaryMs = 0;
  /* Newest-first; the query already ordered ref_summary_ms DESC.
   * Tests may pass arbitrary input arrays, so do not re-sort here
   * (the caller is responsible for ordering). */
  const parts: string[] = [];
  for (const r of refs) {
    if (!r.ref_summary) continue;
    sessionIds.push(r.cc_session_id);
    refIds.push(r.id);
    if (r.ref_summary_ms && r.ref_summary_ms > summaryMs) {
      summaryMs = r.ref_summary_ms;
    }
    const ts = r.ref_summary_ms
      ? new Date(r.ref_summary_ms).toISOString()
      : 'unknown-time';
    const header = `## Session ${r.cc_session_id.slice(0, 8)} (${ts})`;
    parts.push(`${header}\n${r.ref_summary.trim()}`);
  }
  if (parts.length === 0) return null;
  let body = parts.join(SESSION_SEPARATOR);
  if (body.length > maxChars) {
    /* Hard cap applies post-concat. Slice + an explicit truncation
     * marker so a downstream reader knows the tail was dropped
     * rather than the LLM having silently stopped mid-sentence. */
    body = body.slice(0, Math.max(0, maxChars - 32)).trimEnd();
    body += '\n\n[truncated: char-cap reached]';
  }
  return {
    summary: body,
    summary_ms: summaryMs,
    source_ref_ids: refIds,
    source_session_ids: sessionIds,
  };
}
