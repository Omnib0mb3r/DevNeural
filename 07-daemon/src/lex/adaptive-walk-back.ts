/**
 * Adaptive walk-back scorer (LEX-AUTONOMY codex item 7 / Fix 44).
 *
 * Replaces the cold-start preload's blunt "sort by ordering DESC and
 * take N" with a multi-signal scorer over lex_transcript_ref rows.
 *
 * Score components (per the ship spec):
 *   recency      exp(-(now - max(latest_chunk_ms, started_ms)) / halfLife)
 *   freshness    0 when ref_summary_ms null;
 *                else 1 - clamp((latest_chunk_ms - ref_summary_ms) / T, 0, 1)
 *   pin          pinned=1  ->  +Infinity (handled as pre-pass)
 *   supersession 0.4 penalty when this ref's source_session_ids subset
 *                exists in a STRICTLY NEWER ref's source_session_ids
 *   failure      0.3 * min(recent_distillation_errors_count, 1.0)
 *   coverage     hard floor (default 0.3); refs below the floor are
 *                excluded unless pinned
 *
 * Weights (defaults; can be overridden via `pickBundles` opts):
 *   w_recency      = 0.5
 *   w_freshness    = 0.3
 *   w_supersession = 0.4 (penalty)
 *   w_failure      = 0.3 (penalty)
 *   pin_bonus      = +Infinity pre-pass
 *
 * Composite (for unpinned refs that pass the coverage floor):
 *   score = w_recency * recency + w_freshness * freshness
 *         - w_supersession * supersession
 *         - w_failure * failure_penalty_normalised
 *
 * The pick order is:
 *   1. Pinned refs (any count) sorted by their score (still computed).
 *   2. Unpinned refs sorted by score DESC.
 *   3. Cap at `limit` (default 5; matches existing cold-start refLimit).
 *
 * Pure module: every external dependency (clock, error counts) flows
 * through opts so tests drive every component deterministically.
 */
import type { LexTranscriptRefRow } from '../store/index-db.js';

export const WALK_BACK_DEFAULT_HALF_LIFE_MS = 12 * 60 * 60 * 1000; // 12h
export const WALK_BACK_DEFAULT_FRESHNESS_THRESHOLD_MS = 600_000; // 10 min
export const WALK_BACK_DEFAULT_COVERAGE_FLOOR = 0.3;
export const WALK_BACK_DEFAULT_LIMIT = 5;

export const WALK_BACK_W_RECENCY = 0.5;
export const WALK_BACK_W_FRESHNESS = 0.3;
export const WALK_BACK_W_SUPERSESSION = 0.4;
export const WALK_BACK_W_FAILURE = 0.3;

export interface ScoreBreakdown {
  recency: number;
  freshness: number;
  supersession: number;
  failure: number;
  /** True when the ref's pinned bit is set; the pre-pass treats this
   * as +Infinity but the composite score field below still carries
   * the unpinned-equivalent score so audit log + dashboards can rank
   * pinned refs against each other. */
  pinned: boolean;
  /** True when coverage_score < floor AND pinned=false. Excluded
   * refs are not returned by pickBundles but the breakdown is still
   * populated so a future dashboard surface can render "excluded:
   * coverage 0.18 < 0.3". */
  excluded_by_coverage: boolean;
  /** Composite score for unpinned refs (computed without the pin
   * bonus). For pinned refs this still carries the unpinned-equiv
   * score so the pinned-pre-pass can rank pinned refs against each
   * other deterministically. */
  total: number;
}

export interface ScoreContext {
  /** Clock; defaults to Date.now in callers. */
  now: number;
  /** Half-life for the recency decay. */
  halfLifeMs?: number;
  /** Threshold for the freshness score's clamp. Matches Fix 43
   * stale-watch threshold so the surfacing layers stay in lock-step. */
  freshnessThresholdMs?: number;
  /** Map keyed by cc_session_id -> count of distillation_error_log
   * rows in the rolling 1h window. Capped at 5 by the caller so a
   * flapping anchor cannot drive the score to -Infinity. Missing
   * key = 0 failures. */
  recentErrorCountByCc?: Map<string, number>;
  /** Hard coverage floor. Refs below this are excluded unless
   * pinned. Default 0.3. */
  coverageFloor?: number;
  /** Weight overrides. Defaults populated from WALK_BACK_W_*. */
  weights?: {
    recency?: number;
    freshness?: number;
    supersession?: number;
    failure?: number;
  };
}

function parseSessionIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/* Subset check: every element of `inner` appears in `outer`. Empty
 * `inner` returns false (an empty session-id set cannot be the basis
 * for a supersession claim). */
function isSubsetOf(inner: string[], outer: string[]): boolean {
  if (inner.length === 0) return false;
  const outerSet = new Set(outer);
  for (const v of inner) if (!outerSet.has(v)) return false;
  return true;
}

export function scoreRef(
  ref: LexTranscriptRefRow,
  ctx: ScoreContext,
  allRefs: LexTranscriptRefRow[],
): ScoreBreakdown {
  const halfLife = ctx.halfLifeMs ?? WALK_BACK_DEFAULT_HALF_LIFE_MS;
  const threshold =
    ctx.freshnessThresholdMs ?? WALK_BACK_DEFAULT_FRESHNESS_THRESHOLD_MS;
  const floor = ctx.coverageFloor ?? WALK_BACK_DEFAULT_COVERAGE_FLOOR;
  const w = {
    recency: ctx.weights?.recency ?? WALK_BACK_W_RECENCY,
    freshness: ctx.weights?.freshness ?? WALK_BACK_W_FRESHNESS,
    supersession: ctx.weights?.supersession ?? WALK_BACK_W_SUPERSESSION,
    failure: ctx.weights?.failure ?? WALK_BACK_W_FAILURE,
  };

  /* recency_decay over max(latest_chunk_ms, started_ms). Latest chunk
   * is a better signal when available; started_ms is the fallback for
   * legacy refs with no chunk activity recorded. */
  const ageAnchor = Math.max(
    ref.latest_chunk_ms ?? 0,
    ref.started_ms,
  );
  const ageMs = Math.max(0, ctx.now - ageAnchor);
  const recency = halfLife > 0 ? Math.exp(-ageMs / halfLife) : 0;

  /* freshness: 0 when never distilled; otherwise 1 minus the
   * normalised lag between the latest chunk and the last distillation.
   * If both timestamps are null, the ref has no activity to compare;
   * default to 0 (no freshness signal). */
  let freshness = 0;
  if (ref.ref_summary_ms !== null) {
    const latest = ref.latest_chunk_ms ?? ref.ref_summary_ms;
    const lag = Math.max(0, latest - ref.ref_summary_ms);
    freshness = 1 - clamp01(lag / threshold);
  }

  /* supersession_penalty: 0.4 (the weight) when this ref's
   * source_session_ids set is a non-trivial subset of a strictly newer
   * ref's set. Today every per-session distill carries a single-element
   * source_session_ids (own cc_session_id), so this fires only when
   * codex 8+ introduces multi-session distillations. Wired regardless
   * so the surface stays ready. */
  let supersession = 0;
  const thisSet = parseSessionIds(ref.source_session_ids);
  if (thisSet.length > 0) {
    for (const newer of allRefs) {
      if (newer.id === ref.id) continue;
      if (newer.started_ms <= ref.started_ms) continue;
      const newerSet = parseSessionIds(newer.source_session_ids);
      if (newerSet.length === 0) continue;
      if (isSubsetOf(thisSet, newerSet)) {
        supersession = 1; // binary; the weight is applied in the composite
        break;
      }
    }
  }

  /* failure: count from the rolling-1h error log, clamped to 1.0
   * after dividing by the cap so the penalty stays bounded. Empty
   * map / missing key = no failures. */
  const failureCount = ctx.recentErrorCountByCc?.get(ref.cc_session_id) ?? 0;
  const failure = clamp01(failureCount / 5);

  const pinned = ref.pinned === 1;
  const coverage = ref.coverage_score ?? 1; // unsummarised refs pass the floor
  const excluded_by_coverage = !pinned && coverage < floor;

  const total =
    w.recency * recency +
    w.freshness * freshness -
    w.supersession * supersession -
    w.failure * failure;

  return {
    recency,
    freshness,
    supersession,
    failure,
    pinned,
    excluded_by_coverage,
    total,
  };
}

export interface SelectedRef {
  ref: LexTranscriptRefRow;
  score: ScoreBreakdown;
  reason: 'pinned' | 'scored';
}

export interface PickBundlesOptions {
  now: number;
  limit?: number;
  halfLifeMs?: number;
  freshnessThresholdMs?: number;
  coverageFloor?: number;
  recentErrorCountByCc?: Map<string, number>;
  weights?: ScoreContext['weights'];
}

/* Walk-back primitive. Takes the candidate ref pool (anchor-refs path
 * passes listLexTranscriptRefs filtered by current session; label-match
 * path can pass the union across siblings). Returns the ordered final
 * list with scoring breakdown attached so the audit surfaces can
 * render "ref X chosen because pin / score 0.61".
 *
 * Order:
 *   1. Pinned refs sorted by composite score DESC.
 *   2. Unpinned refs that pass the coverage floor, sorted by composite
 *      score DESC.
 *   3. Cap at `limit`.
 *
 * The combined order means a pinned ref always lands in the output up
 * to `limit`; surplus pinned refs (more than `limit` of them) get
 * truncated with the rest. The audit return field carries every
 * scored ref so dashboards can show what didn't make the cut. */
export function pickBundles(
  refs: LexTranscriptRefRow[],
  opts: PickBundlesOptions,
): { selected: SelectedRef[]; ranked: SelectedRef[] } {
  const limit = opts.limit ?? WALK_BACK_DEFAULT_LIMIT;
  const ctx: ScoreContext = {
    now: opts.now,
    ...(opts.halfLifeMs !== undefined ? { halfLifeMs: opts.halfLifeMs } : {}),
    ...(opts.freshnessThresholdMs !== undefined
      ? { freshnessThresholdMs: opts.freshnessThresholdMs }
      : {}),
    ...(opts.coverageFloor !== undefined
      ? { coverageFloor: opts.coverageFloor }
      : {}),
    ...(opts.recentErrorCountByCc
      ? { recentErrorCountByCc: opts.recentErrorCountByCc }
      : {}),
    ...(opts.weights ? { weights: opts.weights } : {}),
  };
  const ranked: SelectedRef[] = refs.map((ref) => ({
    ref,
    score: scoreRef(ref, ctx, refs),
    reason: 'scored' as const,
  }));
  /* Pre-pass: pinned refs forced into the selected list ahead of
   * everything else, sorted by their own scores. */
  const pinned = ranked
    .filter((r) => r.score.pinned)
    .map((r) => ({ ...r, reason: 'pinned' as const }))
    .sort((a, b) => b.score.total - a.score.total);
  const eligibleUnpinned = ranked
    .filter((r) => !r.score.pinned && !r.score.excluded_by_coverage)
    .sort((a, b) => b.score.total - a.score.total);
  const merged: SelectedRef[] = [];
  for (const r of pinned) {
    if (merged.length >= limit) break;
    merged.push(r);
  }
  for (const r of eligibleUnpinned) {
    if (merged.length >= limit) break;
    /* Dedup against any pinned ref already merged so a pinned ref
     * does not double-render. */
    if (merged.some((m) => m.ref.id === r.ref.id)) continue;
    merged.push(r);
  }
  return { selected: merged, ranked };
}

/* Helper: build the recent-error map the scorer expects from a list of
 * raw distillation_error_log rows. Calling code typically reads the
 * rows once per cold-start tick and reuses the resulting Map across
 * all refs. Capping at 5 keeps the penalty bounded even when a single
 * cc_session_id is responsible for a burst. */
export function buildRecentErrorMap(
  rows: Array<{ cc_session_id: string | null; error_class: string }>,
): Map<string, number> {
  const out = new Map<string, number>();
  const COUNTABLE: ReadonlySet<string> = new Set([
    'provider_threw',
    'empty_llm_reply',
  ]);
  for (const row of rows) {
    if (!row.cc_session_id) continue;
    if (!COUNTABLE.has(row.error_class)) continue;
    out.set(row.cc_session_id, (out.get(row.cc_session_id) ?? 0) + 1);
  }
  return out;
}
