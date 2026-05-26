/**
 * Source-graph payload builder (LEX-AUTONOMY codex item 8 / Fix 45).
 *
 * Single primitive consumed by both the cold-start preload (Lex side)
 * and the worker boot handoff (worker side). Projects the brainstorm
 * corpus (brainstorm_sessions + lex_transcript_ref + brainstorm_chunks
 * + distillation_error_log) through Fix 42 staleness + Fix 44 adaptive
 * walk-back into a structured slice both renderers can format.
 *
 * Deterministic by contract: same anchor + same `now` -> same payload
 * bytes. Stable ordering rules:
 *   - anchor lookup is keyed by anchor_id (1:1)
 *   - ref ordering: pickBundles output (already deterministic by
 *     Fix 44; pinned-first then score DESC then ordering DESC then
 *     cc_session_id ASC as final tiebreak)
 *   - recent_errors sorted by ts DESC then id ASC (the list helper
 *     already returns DESC; ts-equal rows tie-break on id)
 *
 * No live timestamps appear in the returned shape; downstream
 * renderers compute relative-age strings from `now` against the
 * payload's ref_summary_ms / latest_chunk_ms / oldest_stale_ms.
 */
import * as fs from 'node:fs';
import type {
  BrainstormSessionRow,
  IndexDb,
  LexTranscriptRefRow,
} from '../store/index-db.js';
import { isRefStale } from './lex-transcript-ref.js';
import {
  buildRecentErrorMap,
  pickBundles,
  type ScoreBreakdown,
} from './adaptive-walk-back.js';
import { extractLastTurnPairs } from './sibling-index.js';

export interface SourcePayloadInput {
  db: IndexDb;
  /** Anchor id (brainstorm row id = lex_session id). */
  anchorId: string;
  /** Active CC session to exclude from the ref pool. Worker boot
   * passes the worker's brand-new cc; cold-start passes the Lex CC. */
  currentCcSessionId?: string | null;
  /** Cap on rendered refs. Cold-start uses 5 (existing default);
   * worker boot uses 3 (terser). */
  refLimit?: number;
  /** Cap on turn-pairs extracted per ref. Cold-start uses 5; worker
   * boot uses 3. */
  pairsPerRef?: number;
  /** Frozen clock. Required for determinism. */
  now: () => number;
  /** Test seam: filesystem read for transcript_path jsonls. */
  readTranscript?: (path: string) => string | null;
  /** Codex 9 hook: when true, the payload is built for a first-attach
   * spawn (no prior CC session under this anchor). Today the only
   * effect is the staleness_state defaulting to 'no_refs' when refs
   * is empty; codex 9 wires the bootstrap-directive substitution. */
  firstAttach?: boolean;
}

export interface SelectedRefPayload {
  ref_id: number;
  cc_session_id: string;
  ordering: number;
  started_ms: number;
  ended_ms: number | null;
  ref_summary: string | null;
  ref_summary_ms: number | null;
  coverage_score: number | null;
  latest_chunk_ms: number | null;
  is_stale: boolean;
  pinned: boolean;
  score: ScoreBreakdown;
  reason: 'pinned' | 'scored';
  turn_pairs: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface SourcePayload {
  anchor: {
    id: string;
    user_label: string | null;
    derived_label: string | null;
    last_summary: string | null;
    last_summary_ms: number | null;
  };
  refs: SelectedRefPayload[];
  freshness: {
    total: number;
    fresh: number;
    stale: number;
    oldest_stale_ms: number | null;
  };
  staleness_state: 'all_fresh' | 'partial_stale' | 'all_stale' | 'no_refs';
  recent_errors: Array<{
    id: string;
    ts: string;
    cc_session_id: string | null;
    error_class: string;
    error_message: string | null;
  }>;
  first_attach: boolean;
  /** Anchor row was missing entirely. Caller decides whether to log
   * or no-op. */
  not_found: boolean;
}

const DEFAULT_REF_LIMIT = 5;
const DEFAULT_PAIRS_PER_REF = 5;

function defaultReadTranscript(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function emptyAnchor(anchorId: string): SourcePayload['anchor'] {
  return {
    id: anchorId,
    user_label: null,
    derived_label: null,
    last_summary: null,
    last_summary_ms: null,
  };
}

export function buildSourceGraphPayload(
  input: SourcePayloadInput,
): SourcePayload {
  const refLimit = input.refLimit ?? DEFAULT_REF_LIMIT;
  const pairs = input.pairsPerRef ?? DEFAULT_PAIRS_PER_REF;
  const read = input.readTranscript ?? defaultReadTranscript;
  const now = input.now();

  let anchorRow: BrainstormSessionRow | null = null;
  try {
    anchorRow = input.db.getBrainstorm(input.anchorId);
  } catch {
    anchorRow = null;
  }
  if (!anchorRow) {
    return {
      anchor: emptyAnchor(input.anchorId),
      refs: [],
      freshness: { total: 0, fresh: 0, stale: 0, oldest_stale_ms: null },
      staleness_state: 'no_refs',
      recent_errors: [],
      first_attach: input.firstAttach === true,
      not_found: true,
    };
  }

  let allRefs: LexTranscriptRefRow[] = [];
  try {
    allRefs = input.db.listLexTranscriptRefs(input.anchorId);
  } catch {
    allRefs = [];
  }
  const currentCc = input.currentCcSessionId ?? null;
  const eligible = allRefs.filter(
    (r) => !currentCc || r.cc_session_id !== currentCc,
  );

  let errorMap: Map<string, number> | undefined;
  let recentErrors: SourcePayload['recent_errors'] = [];
  try {
    const errRows = input.db.listRecentDistillationErrors(50, {
      brainstormId: input.anchorId,
    });
    errorMap = buildRecentErrorMap(errRows);
    recentErrors = errRows.slice(0, 5).map((r) => ({
      id: r.id,
      ts: r.ts,
      cc_session_id: r.cc_session_id,
      error_class: r.error_class,
      error_message: r.error_message,
    }));
  } catch {
    /* migration 042 not applied; skip */
  }

  const { selected } = pickBundles(eligible, {
    now,
    limit: refLimit,
    ...(errorMap ? { recentErrorCountByCc: errorMap } : {}),
  });

  /* Tiebreak the pickBundles output deterministically: same score
   * (rare but possible) -> sort by ordering DESC, then cc_session_id
   * ASC. pickBundles already orders pinned-first + score-DESC; this
   * sort is stable on the head of the array so the secondary keys
   * only fire when scores collide. */
  const orderedSelected = selected.slice().sort((a, b) => {
    if (a.score.pinned !== b.score.pinned) return a.score.pinned ? -1 : 1;
    if (a.score.total !== b.score.total) return b.score.total - a.score.total;
    if (a.ref.ordering !== b.ref.ordering) return b.ref.ordering - a.ref.ordering;
    return a.ref.cc_session_id.localeCompare(b.ref.cc_session_id);
  });

  const refsPayload: SelectedRefPayload[] = orderedSelected.map((s) => {
    let turnPairs: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    try {
      const text = read(s.ref.transcript_path);
      if (text) turnPairs = extractLastTurnPairs(text, pairs);
    } catch {
      /* observational; an unreadable transcript renders without
       * turn pairs */
    }
    return {
      ref_id: s.ref.id,
      cc_session_id: s.ref.cc_session_id,
      ordering: s.ref.ordering,
      started_ms: s.ref.started_ms,
      ended_ms: s.ref.ended_ms,
      ref_summary: s.ref.ref_summary,
      ref_summary_ms: s.ref.ref_summary_ms,
      coverage_score: s.ref.coverage_score,
      latest_chunk_ms: s.ref.latest_chunk_ms,
      is_stale: isRefStale(s.ref),
      pinned: s.ref.pinned === 1,
      score: s.score,
      reason: s.reason,
      turn_pairs: turnPairs,
    };
  });

  let staleCount = 0;
  let oldestStaleMs: number | null = null;
  for (const r of refsPayload) {
    if (!r.is_stale) continue;
    staleCount += 1;
    if (
      r.latest_chunk_ms !== null &&
      (oldestStaleMs === null || r.latest_chunk_ms < oldestStaleMs)
    ) {
      oldestStaleMs = r.latest_chunk_ms;
    }
  }
  const total = refsPayload.length;
  const freshness = {
    total,
    fresh: total - staleCount,
    stale: staleCount,
    oldest_stale_ms: oldestStaleMs,
  };
  let staleness_state: SourcePayload['staleness_state'];
  if (total === 0) staleness_state = 'no_refs';
  else if (staleCount === 0) staleness_state = 'all_fresh';
  else if (staleCount === total) staleness_state = 'all_stale';
  else staleness_state = 'partial_stale';

  return {
    anchor: {
      id: anchorRow.id,
      user_label: anchorRow.user_label ?? null,
      derived_label: anchorRow.derived_label ?? null,
      last_summary: anchorRow.last_summary ?? null,
      last_summary_ms: anchorRow.last_summary_ms ?? null,
    },
    refs: refsPayload,
    freshness,
    staleness_state,
    recent_errors: recentErrors,
    first_attach: input.firstAttach === true,
    not_found: false,
  };
}
