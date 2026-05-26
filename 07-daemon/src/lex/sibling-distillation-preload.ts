/**
 * Sibling distillation preloader.
 *
 * At Lex spawn / reopen time, buildSiblingIndex renders a tiny block
 * listing prior brainstorm_sessions that share the new session's
 * user_label. Each line carries an optional 10-word distillation
 * pulled from brainstorm_sessions.last_summary. Older rows can have a
 * null last_summary (session ended before the distillation pipeline
 * landed, or the run hit the Anthropic-provider skip path); without a
 * preload the sibling block degrades silently to id + label + started.
 *
 * preloadSiblingDistillations fixes that for the top N most-recent
 * siblings by calling an injected generator and persisting its
 * output via updateBrainstorm. Bounded so a cold spawn cannot
 * cascade into a flood of LLM calls; the wider sweep is the
 * separate backfill job.
 *
 * Pure module: every side effect (LLM call, db write) flows through
 * injected parameters so tests can verify the preload without
 * touching ollama or anthropic.
 */
import type {
  BrainstormSessionRow,
  IndexDb,
  LexTranscriptRefRow,
} from '../store/index-db.js';
import { buildRecentErrorMap, pickBundles } from './adaptive-walk-back.js';

export type DistillationGenerator = (
  row: BrainstormSessionRow,
) => Promise<string | null>;

export interface PreloadOptions {
  db: IndexDb;
  /** New session's user_label. Case-insensitive, whitespace-trimmed. */
  label: string | null | undefined;
  /** New session id; excluded from the sibling list. */
  excludeId?: string | null;
  /** LLM-driven generator. Returns the distillation string (any
   * length; sibling-index trims to N words at render time) or null
   * to skip. Throws are caught and treated as null. */
  generator: DistillationGenerator;
  /** Max siblings to preload. Default 2. */
  limit?: number;
  /** Clock for the last_summary_ms stamp. */
  now?: () => number;
  /** Codex item 12: active brainstorm's project_scope_id (migration
   * 044). When set, siblings are grouped by matching scope id instead
   * of by user_label. Falls back to label when null or when a sibling
   * row has no scope id yet (legacy compat). */
  projectScopeId?: string | null;
}

export interface PreloadResult {
  /** Rows whose last_summary was written. */
  preloaded: string[];
  /** Rows the generator returned null / threw for. */
  skipped: string[];
  /** Rows that already had a last_summary and did not need preload. */
  already_present: string[];
}

function normLabel(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

export async function preloadSiblingDistillations(
  opts: PreloadOptions,
): Promise<PreloadResult> {
  const target = normLabel(opts.label);
  const out: PreloadResult = {
    preloaded: [],
    skipped: [],
    already_present: [],
  };
  if (!target) return out;
  const limit = opts.limit ?? 2;
  const now = opts.now ?? Date.now;

  /* Over-fetch; the label space is small. Order is started_ms DESC
   * straight from listBrainstorms so the slice below = most-recent
   * limit rows. */
  const rows = opts.db.listBrainstorms({ limit: 200 });
  const exclude = opts.excludeId ?? null;
  const activeScope = opts.projectScopeId ?? null;
  /* Codex item 12 (Fix 49): prefer project_scope_id grouping when
   * BOTH the active anchor and the candidate row carry a non-null
   * scope id. Falls back to label-match when either side is null
   * (legacy compat). TODO codex 12 follow-up: kill the label fallback
   * branch after the 30-day backfill window. */
  const matches = rows.filter((r) => {
    if (exclude && r.id === exclude) return false;
    const rowScope = (r as unknown as { project_scope_id?: string | null })
      .project_scope_id;
    if (activeScope && rowScope) return rowScope === activeScope;
    return normLabel(r.user_label) === target;
  });

  /* Codex item 7: rank label-matched siblings via the adaptive walk-
   * back scorer. Each sibling row's score is the MAX score across its
   * lex_transcript_ref children; a sibling with a pinned ref bubbles
   * to the top, a sibling with no refs falls back to a recency-only
   * score (started_ms vs now). The ordered list becomes the
   * force-distill pick order so the limit-N slots go to the most
   * relevant siblings. */
  const orderedMatches = rankSiblingsByWalkBack(matches, opts.db, now());

  let usedSlots = 0;
  for (const row of orderedMatches) {
    if (row.last_summary && row.last_summary.trim().length > 0) {
      out.already_present.push(row.id);
      continue;
    }
    if (usedSlots >= limit) {
      /* Beyond N: the backfill job picks these up. */
      out.skipped.push(row.id);
      continue;
    }
    usedSlots += 1;
    let distillation: string | null = null;
    try {
      distillation = await opts.generator(row);
    } catch {
      distillation = null;
    }
    if (distillation && distillation.trim().length > 0) {
      opts.db.updateBrainstorm(row.id, {
        last_summary: distillation.trim(),
        last_summary_ms: now(),
      });
      out.preloaded.push(row.id);
    } else {
      out.skipped.push(row.id);
    }
  }
  return out;
}

/* Codex item 7 helper: rank sibling brainstorm rows by the best score
 * across their lex_transcript_ref children. Used by the label-match
 * fallback to replace the started_ms-only ordering with the multi-
 * signal walk-back scorer.
 *
 * For each sibling row:
 *   1. Fetch all refs (listLexTranscriptRefs).
 *   2. Run pickBundles with limit=1 to pull the highest-score ref.
 *   3. Use that ref's composite score as the sibling's score; pinned
 *      refs push the sibling to the top via the +Infinity-equivalent
 *      pinned bonus.
 *   4. Sibling rows with no refs fall back to a recency-only score
 *      keyed on row.started_ms so the ordering stays deterministic.
 *
 * Returns a NEW array; the input list is not mutated. */
function rankSiblingsByWalkBack(
  rows: BrainstormSessionRow[],
  db: IndexDb,
  now: number,
): BrainstormSessionRow[] {
  if (rows.length <= 1) return rows;
  const scored = rows.map((row) => {
    let refs: LexTranscriptRefRow[] = [];
    try {
      refs = db.listLexTranscriptRefs(row.id);
    } catch {
      /* missing migration / dropped table; row falls back to recency */
    }
    let errorMap: Map<string, number> | undefined;
    try {
      const errRows = db.listRecentDistillationErrors(200, {
        brainstormId: row.id,
      });
      errorMap = buildRecentErrorMap(errRows);
    } catch {
      /* migration 042 not applied; empty map */
    }
    let bestScore = recencyOnlyFallback(row.started_ms, now);
    let pinnedBoost = false;
    if (refs.length > 0) {
      const { ranked } = pickBundles(refs, {
        now,
        limit: refs.length,
        ...(errorMap ? { recentErrorCountByCc: errorMap } : {}),
      });
      if (ranked.length > 0) {
        const top = ranked.reduce((a, b) =>
          a.score.total >= b.score.total ? a : b,
        );
        bestScore = top.score.total;
        pinnedBoost = ranked.some((r) => r.score.pinned);
      }
    }
    return { row, score: bestScore, pinnedBoost };
  });
  scored.sort((a, b) => {
    if (a.pinnedBoost !== b.pinnedBoost) return a.pinnedBoost ? -1 : 1;
    return b.score - a.score;
  });
  return scored.map((s) => s.row);
}

/* Recency-only fallback for label-match siblings that have no refs.
 * Same shape as adaptive-walk-back's recency_decay (exp(-age/halfLife))
 * scaled by the recency weight so the sibling's score stays comparable
 * to scored refs. Half-life is fixed at 12h to match the module's
 * default. */
function recencyOnlyFallback(startedMs: number, now: number): number {
  const halfLifeMs = 12 * 60 * 60 * 1000;
  const ageMs = Math.max(0, now - startedMs);
  return 0.5 * Math.exp(-ageMs / halfLifeMs);
}
