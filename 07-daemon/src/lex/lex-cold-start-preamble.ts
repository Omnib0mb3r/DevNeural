/**
 * Cold-start preamble assembler + race-free force-distill helper.
 *
 * The cold-start preload route used to call buildSiblingIndex straight
 * against whatever last_summary rows happened to be present, which
 * meant a fresh Lex session booted with stale or missing
 * distillations whenever the steady-state cron had not yet caught up
 * to the just-ended sibling (the user's typical "Lex compacted 30s
 * ago, click new session" flow). preloadColdStartSiblings closes that
 * race: it calls preloadSiblingDistillations synchronously with a
 * top-N force window so the most-recent siblings always have current
 * last_summary rows before buildSiblingIndex reads them.
 *
 * The same call returns enough metadata for two of the three
 * visibility layers spec'd alongside the compaction work:
 *
 *   - first-turn Lex preamble: a one-liner like "Loaded 4 sibling
 *     sessions, last distilled 14:32 EDT, 12 recent turns appended."
 *     that Lex prints verbatim on its first reply so the user reads
 *     immediately what context primed.
 *   - brainstorm header status row: a tiny pill in the brainstorm UI
 *     showing "context: N siblings + M turns" or "context: failed
 *     (reason)" depending on the preload outcome.
 *
 * Pure module: every side effect (LLM call, db write, clock) flows
 * through injected dependencies so tests can drive the race-fix
 * branches without touching ollama or the real db.
 */
import type { BrainstormSessionRow, IndexDb, LexTranscriptRefRow } from '../store/index-db.js';
import {
  preloadSiblingDistillations,
  type DistillationGenerator,
  type PreloadResult,
} from './sibling-distillation-preload.js';
import { extractLastTurnPairs } from './sibling-index.js';
import { findLatestHandover } from './handover-writer.js';
import { isRefStale } from './lex-transcript-ref.js';
import type { PerSessionDistillationGenerator } from './distillation-generator.js';
import { buildRecentErrorMap, pickBundles } from './adaptive-walk-back.js';
import { buildSourceGraphPayload } from './source-graph-payload.js';
import * as fs from 'node:fs';

export interface ColdStartPreloadInput {
  db: IndexDb;
  /** Generator that calls the local-only LLM provider to produce a
   * distillation. Required when force_for_top_n > 0; null disables
   * the synchronous force pass and falls back to "use whatever
   * last_summary rows already exist". */
  generator: DistillationGenerator | null;
  /** New session's user_label (the join key for siblings). */
  label: string | null | undefined;
  /** New session id; excluded from the sibling set. */
  excludeId: string | null;
  /** Synchronously force-distill the top N siblings if their
   * last_summary is missing. Defaults to 2 (the spec's "preload
   * covers the top 2 most-recent siblings"). Set to 0 to disable
   * the race-fix pass; the existing steady-state cron is then
   * responsible for keeping siblings current. */
  forceForTopN?: number;
  /** Clock for the last_summary_ms stamp on force-distilled rows. */
  now?: () => number;
  /** Anchor (lex_session) id. When set, the prior-CC-transcripts under
   * this anchor become the sibling source instead of label-matched
   * brainstorm rows. Mirrors buildSiblingIndex's anchor-refs primary
   * path so the preamble counts match the block actually injected. */
  anchorId?: string | null;
  /** Newly-bound CC session UUID. Excluded from the prior-refs list
   * so the active session never counts itself. */
  currentCcSessionId?: string | null;
  /** Cap on prior refs to surface for the anchor-refs path. Mirrors
   * buildSiblingIndex's refLimit default of 2. */
  anchorRefLimit?: number;
  /** Max user/assistant pairs to extract per prior ref for the
   * recent_turns_appended count. Mirrors buildSiblingIndex's
   * pairsPerRef default of 5. */
  anchorPairsPerRef?: number;
  /** Test seam: filesystem read for transcript_path jsonls. */
  readTranscript?: (p: string) => string | null;
  /** Phase 4 of LEX-STANDALONE-SUPERVISION: prefer the freshest
   * HANDOVER doc when its on-disk mtime is newer than the row's
   * last_summary_ms. Injected for tests; production uses
   * handover-writer.findLatestHandover + fs.statSync. Return null
   * for "no handover doc found"; the preload falls back to
   * last_summary_ms in that case. */
  findHandover?: (brainstormId: string) => { mtimeMs: number; filePath: string } | null;
  /** Codex item 5: per-session distillation generator used to catch
   * up stale refs synchronously before the block ships. Required when
   * staleness detection is non-zero AND the sync barrier is active;
   * null disables the catchup (the [stale] tag still renders, but no
   * distillation runs). */
  perSessionGenerator?: PerSessionDistillationGenerator | null;
  /** Codex item 5: total wall-clock budget (ms) across all stale-ref
   * catchup calls. Refs that miss this window keep their [stale]
   * tag and surface in partial_sync=true on the audit row. Default
   * 5000 per spec. */
  syncBudgetMs?: number;
  /** Codex item 5: max stale refs to catch up per preload tick.
   * Default 3 per spec. */
  syncMaxRefs?: number;
  /** Fix 55: when distillation lags the latest child session by more
   * than this many ms, verdict promotes to 'stale'. Default
   * STALE_GAP_MS_DEFAULT (1h). */
  staleGapMs?: number;
  /** Fix 55: when distillation lags by more than this, verdict
   * promotes to 'outdated'. Default OUTDATED_GAP_MS_DEFAULT (7d). */
  outdatedGapMs?: number;
}

export interface ColdStartPreloadSummary {
  /** Same buckets the underlying preloader returns. */
  preload: PreloadResult;
  /** Count of sibling rows actually surfaced (preloaded + already
   * present), capped at the limit. The header pill renders this. */
  sibling_count: number;
  /** ms-since-epoch of the most recent last_summary_ms on any
   * surfaced sibling. null when no siblings have a distillation
   * yet. The first-turn preamble formats this as HH:MM local. */
  last_distilled_ms: number | null;
  /** Total brainstorm_chunks rows across the surfaced siblings.
   * Renders in the preamble as "M recent turns appended". */
  recent_turns_appended: number;
  /** When the preload could not complete cleanly (no label, no
   * siblings, generator threw before any work, etc.) the failure
   * reason rides here so the header pill can render "context:
   * failed (no-label)". null on success. */
  failure_reason: string | null;
  /** Phase 4 of LEX-STANDALONE-SUPERVISION: count of siblings whose
   * freshest source was a HANDOVER-*.md doc rather than the row's
   * last_summary_ms column. Surfaces in the preload event log so
   * the dashboard panel can show "context: 2 siblings (1 handover)".
   * Always 0 when findHandover is not wired or no handover docs
   * exist for the surfaced rows. */
  handover_sourced_count?: number;
  /** Codex item 5 freshness barrier metrics. */
  stale_refs_count: number;
  synced_refs_count: number;
  partial_sync: boolean;
  /** Fix 55 cold-start vetting: a single token Lex (and the panel) can
   * branch on without re-deriving from the underlying counts.
   *   - 'fresh':    distillation is current; recent_turns small enough
   *                 that the summary covers the active thread.
   *   - 'stale':    distillation exists but lags the latest child
   *                 session by more than STALE_GAP_MS_DEFAULT.
   *   - 'outdated': distillation lag > OUTDATED_GAP_MS_DEFAULT, OR
   *                 last_distilled_ms is null AND there is at least
   *                 one prior child session. Treat as "no usable
   *                 context": Lex should ask the operator for a
   *                 catch-up.
   *   - 'partial':  partial_sync=true, OR stale_refs > synced_refs;
   *                 the catchup ran but didn't finish.
   *   - 'empty':    no prior sibling sessions at all (cold-cold start).
   */
  context_verdict: 'fresh' | 'stale' | 'partial' | 'outdated' | 'empty';
  /** Fix 55: id of the most recent child CC session bound to the
   * brainstorm. null when no refs exist. Lex reads this to decide
   * what to confirm with the operator on cold start. */
  last_child_session_id: string | null;
  /** Fix 55: human label for that session. Prefers
   * lex_session.title -> lex_session.derived_title -> brainstorm
   * user_label -> derived_label -> first 60 chars of cc_session_id.
   * null when no refs exist. */
  last_child_session_title: string | null;
  /** Fix 55: ended_ms of that child session (falls back to started_ms
   * when ended_ms is null). null when no refs exist. */
  last_child_session_ended_ms: number | null;
  /** Fix 55: milliseconds between last_child_session_ended_ms and
   * last_distilled_ms. Positive => distillation lags; null when
   * either side is missing. Drives the verdict thresholds and
   * surfaces in the preamble so Lex can quote it back. */
  distillation_gap_ms: number | null;
}

/** Fix 55 cold-start vetting thresholds. Tunable via env so the user
 * can tighten or loosen the "good enough" window without a rebuild. */
export const STALE_GAP_MS_DEFAULT = 60 * 60 * 1000;
export const OUTDATED_GAP_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;

const TOP_N_DEFAULT = 2;
const ANCHOR_REF_LIMIT_DEFAULT = 5;
const ANCHOR_PAIRS_PER_REF_DEFAULT = 5;
const SYNC_BUDGET_MS_DEFAULT = 5_000;
const SYNC_MAX_REFS_DEFAULT = 3;

function readJsonl(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/* Codex item 5 sync catchup. Pure async helper so the staleness
 * resolver can be unit-tested without spinning the route up.
 *
 * For each stale ref (capped to `maxRefs`), call the per-session
 * generator and persist its output to lex_transcript_ref. Caps total
 * wall-clock against `budgetMs`; refs that miss the window remain
 * stale and surface in `partial`.
 *
 * The first overrun ref is the one whose generator call ran past the
 * remaining budget. Subsequent refs are skipped without invoking the
 * generator to keep the route's response-time SLO predictable. */
export interface SyncCatchupInput {
  db: IndexDb;
  refs: LexTranscriptRefRow[];
  brainstormIdForRef: (ref: LexTranscriptRefRow) => string;
  perSessionGenerator: PerSessionDistillationGenerator;
  budgetMs: number;
  maxRefs: number;
  now?: () => number;
}

export interface SyncCatchupResult {
  attempted: number[];
  synced: number[];
  partial: boolean;
}

export async function runStaleRefCatchup(
  input: SyncCatchupInput,
): Promise<SyncCatchupResult> {
  const now = input.now ?? Date.now;
  const out: SyncCatchupResult = {
    attempted: [],
    synced: [],
    partial: false,
  };
  const target = input.refs.slice(0, Math.max(0, input.maxRefs));
  if (target.length < input.refs.length) {
    /* spec contract: refs we never tried still count as partial. */
    out.partial = true;
  }
  const startMs = now();
  for (const ref of target) {
    const elapsed = now() - startMs;
    if (elapsed >= input.budgetMs) {
      out.partial = true;
      continue;
    }
    out.attempted.push(ref.id);
    const brainstormId = input.brainstormIdForRef(ref);
    if (!brainstormId || !ref.cc_session_id) {
      out.partial = true;
      continue;
    }
    const totalScoped = input.db.countBrainstormChunksForSession(
      brainstormId,
      ref.cc_session_id,
    );
    if (totalScoped === 0) {
      /* No chunks under this scope; the staleness predicate must have
       * fired on a NULL ref_summary + non-null latest_chunk_ms set by
       * a different cc_session_id, which is anomalous. Skip and mark
       * partial so the audit row records the unresolved entry. */
      out.partial = true;
      continue;
    }
    let result: Awaited<ReturnType<PerSessionDistillationGenerator>> = null;
    try {
      const remainingBudget = Math.max(0, input.budgetMs - (now() - startMs));
      result = await Promise.race<
        Awaited<ReturnType<PerSessionDistillationGenerator>>
      >([
        input.perSessionGenerator({
          brainstorm_id: brainstormId,
          cc_session_id: ref.cc_session_id,
          totalChunksInSession: totalScoped,
        }),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), remainingBudget);
          if (typeof (t as { unref?: () => void }).unref === 'function') {
            (t as { unref: () => void }).unref();
          }
        }) as Promise<null>,
      ]);
    } catch {
      result = null;
    }
    if (!result) {
      out.partial = true;
      continue;
    }
    try {
      input.db.updateLexTranscriptRef(ref.id, {
        ref_summary: result.summary,
        ref_summary_ms: now(),
        source_chunk_count: result.source_chunk_count,
        source_session_ids: result.source_session_ids,
        coverage_score: result.coverage_score,
      });
      out.synced.push(ref.id);
    } catch {
      out.partial = true;
    }
  }
  return out;
}

/* Fix 55: pick the most recent child session bound to the
 * brainstorm (anchor-refs path) OR the most recent surfaced sibling
 * (label-match path), then resolve a verdict by comparing
 * distillation lag against the configured thresholds. Mutates the
 * summary in place. */
function finalizeContextVerdict(args: {
  summary: ColdStartPreloadSummary;
  db: IndexDb;
  anchorId: string | null;
  siblingRows: BrainstormSessionRow[] | null;
  now: () => number;
  staleGapMs?: number;
  outdatedGapMs?: number;
}): void {
  const { summary, db, anchorId, siblingRows, now } = args;
  const staleGap = args.staleGapMs ?? STALE_GAP_MS_DEFAULT;
  const outdatedGap = args.outdatedGapMs ?? OUTDATED_GAP_MS_DEFAULT;

  /* Last child session lookup. Anchor-refs path: walk
   * lex_transcript_ref for the anchor and pick the newest. Label-match
   * path: take the first surfaced sibling (DESC by started_ms). */
  if (anchorId) {
    try {
      const refs = db.listLexTranscriptRefs(anchorId);
      if (refs.length > 0) {
        const newest = refs
          .slice()
          .sort((a, b) => {
            const ea = a.ended_ms ?? a.started_ms ?? 0;
            const eb = b.ended_ms ?? b.started_ms ?? 0;
            if (eb !== ea) return eb - ea;
            return b.ordering - a.ordering;
          })[0]!;
        summary.last_child_session_id = newest.cc_session_id ?? null;
        summary.last_child_session_ended_ms =
          newest.ended_ms ?? newest.started_ms ?? null;
        const lexSession = (() => {
          try {
            return db.getLexSession(anchorId);
          } catch {
            return null;
          }
        })();
        summary.last_child_session_title =
          lexSession?.title?.trim() ||
          lexSession?.derived_title?.trim() ||
          newest.cc_session_id?.slice(0, 8) ||
          null;
      }
    } catch {
      /* observational: missing anchor or read failure leaves
       * last_child_session_* null and the verdict resolver treats it
       * as no-child-session. */
    }
  } else if (siblingRows && siblingRows.length > 0) {
    const first = siblingRows[0]!;
    summary.last_child_session_id = first.id;
    summary.last_child_session_title =
      first.user_label?.trim() || first.derived_label?.trim() || first.id.slice(0, 8);
    summary.last_child_session_ended_ms =
      first.ended_ms ?? first.started_ms ?? null;
  }

  if (
    summary.last_distilled_ms !== null &&
    summary.last_child_session_ended_ms !== null
  ) {
    summary.distillation_gap_ms = Math.max(
      0,
      summary.last_child_session_ended_ms - summary.last_distilled_ms,
    );
  } else {
    summary.distillation_gap_ms = null;
  }

  /* Verdict resolution. Order matters: 'partial' wins when the
   * catchup did not finish so the operator sees the in-flight gap
   * before any age signal. 'outdated' beats 'stale' on the lag
   * threshold. 'empty' only when there are literally no prior
   * sessions to talk about. */
  void now;
  if (summary.sibling_count === 0 && summary.last_child_session_id === null) {
    summary.context_verdict = 'empty';
    return;
  }
  if (
    summary.partial_sync ||
    summary.stale_refs_count > summary.synced_refs_count
  ) {
    summary.context_verdict = 'partial';
    return;
  }
  const gap = summary.distillation_gap_ms;
  if (summary.last_distilled_ms === null && summary.last_child_session_id) {
    summary.context_verdict = 'outdated';
    return;
  }
  if (gap !== null && gap > outdatedGap) {
    summary.context_verdict = 'outdated';
    return;
  }
  if (gap !== null && gap > staleGap) {
    summary.context_verdict = 'stale';
    return;
  }
  summary.context_verdict = 'fresh';
}

/* Anchor-refs path: returns sibling_count + recent_turns_appended for
 * the prior CC transcripts bound to this anchor. Mirrors
 * buildSiblingIndex's primary path so the preamble's "Loaded N sibling
 * sessions, M turns" reflects the block actually injected into the
 * system prompt. Returns null when the anchor has no prior refs so the
 * caller falls through to the label-match path. */
function summarizeFromAnchor(
  input: ColdStartPreloadInput,
): { sibling_count: number; recent_turns_appended: number; last_distilled_ms: number | null } | null {
  const anchorId = input.anchorId;
  if (!anchorId) return null;
  const refLimit = input.anchorRefLimit ?? ANCHOR_REF_LIMIT_DEFAULT;
  const pairs = input.anchorPairsPerRef ?? ANCHOR_PAIRS_PER_REF_DEFAULT;
  /* Codex item 8 (Fix 45 step 3): call the shared source-graph
   * primitive instead of re-duplicating the pickBundles + filter +
   * extract-turn-pairs pipeline. buildSourceGraphPayload runs the
   * same Fix 44 walk-back scorer with identical inputs (ref pool
   * filtered by currentCcSessionId, error map from
   * distillation_error_log, frozen `now` clock); output is
   * byte-identical for the happy path. */
  const payload = buildSourceGraphPayload({
    db: input.db,
    anchorId,
    ...(input.currentCcSessionId
      ? { currentCcSessionId: input.currentCcSessionId }
      : {}),
    refLimit,
    pairsPerRef: pairs,
    now: input.now ?? Date.now,
    ...(input.readTranscript
      ? { readTranscript: input.readTranscript }
      : {}),
  });
  if (payload.not_found) return null;
  if (payload.refs.length === 0) return null;
  const turns = payload.refs.reduce(
    (sum, r) => sum + r.turn_pairs.length,
    0,
  );
  return {
    sibling_count: payload.refs.length,
    recent_turns_appended: turns,
    last_distilled_ms: payload.anchor.last_summary_ms,
  };
}

export async function preloadColdStartSiblings(
  input: ColdStartPreloadInput,
): Promise<ColdStartPreloadSummary> {
  const out: ColdStartPreloadSummary = {
    preload: { preloaded: [], skipped: [], already_present: [] },
    sibling_count: 0,
    last_distilled_ms: null,
    recent_turns_appended: 0,
    failure_reason: null,
    stale_refs_count: 0,
    synced_refs_count: 0,
    partial_sync: false,
    context_verdict: 'empty',
    last_child_session_id: null,
    last_child_session_title: null,
    last_child_session_ended_ms: null,
    distillation_gap_ms: null,
  };
  const syncBudgetMs = input.syncBudgetMs ?? SYNC_BUDGET_MS_DEFAULT;
  const syncMaxRefs = input.syncMaxRefs ?? SYNC_MAX_REFS_DEFAULT;
  const now = input.now ?? Date.now;
  /* Anchor-refs primary path: when the new session re-binds an
   * existing brainstorm anchor, the prior CC transcripts ARE the
   * siblings. Skip the label-match force-distill (no other brainstorm
   * rows to fire against) and surface the anchor's last_summary_ms +
   * extracted turn count straight away. */
  const fromAnchor = summarizeFromAnchor(input);
  if (fromAnchor) {
    /* Codex item 5: stale-ref catchup on the anchor-refs path.
     * Detect refs whose latest_chunk_ms beats their ref_summary_ms
     * and run the per-session generator against them inside the
     * shared sync budget. Refs that miss the budget keep their
     * [stale] tag (rendered by buildSiblingIndex via isRefStale)
     * and partial_sync=true lands on the audit row. */
    await runAnchorStaleCatchup({
      input,
      summary: out,
      budgetMs: syncBudgetMs,
      maxRefs: syncMaxRefs,
      now,
    });
    out.sibling_count = fromAnchor.sibling_count;
    out.recent_turns_appended = fromAnchor.recent_turns_appended;
    out.last_distilled_ms = fromAnchor.last_distilled_ms;
    finalizeContextVerdict({
      summary: out,
      db: input.db,
      anchorId: input.anchorId ?? null,
      siblingRows: null,
      now,
      staleGapMs: input.staleGapMs,
      outdatedGapMs: input.outdatedGapMs,
    });
    return out;
  }
  const label = (input.label ?? '').trim();
  if (!label) {
    out.failure_reason = 'no-label';
    finalizeContextVerdict({
      summary: out,
      db: input.db,
      anchorId: input.anchorId ?? null,
      siblingRows: null,
      now,
      staleGapMs: input.staleGapMs,
      outdatedGapMs: input.outdatedGapMs,
    });
    return out;
  }
  const forceN = input.forceForTopN ?? TOP_N_DEFAULT;

  /* Race-fix pass: synchronously distill the top-N siblings whose
   * last_summary is still null. preloadSiblingDistillations is the
   * existing entry point - it already awaits each generator call,
   * so this is the canonical "wait for completion" mode. Skipping
   * the pass entirely when generator===null or forceN===0 keeps the
   * shape backward-compatible for callers that don't care about
   * race resolution. */
  if (forceN > 0 && input.generator) {
    try {
      out.preload = await preloadSiblingDistillations({
        db: input.db,
        label,
        excludeId: input.excludeId ?? null,
        generator: input.generator,
        limit: forceN,
        now,
      });
    } catch (err) {
      out.failure_reason = `preload-threw: ${(err as Error).message}`;
      finalizeContextVerdict({
        summary: out,
        db: input.db,
        anchorId: input.anchorId ?? null,
        siblingRows: null,
        now,
        staleGapMs: input.staleGapMs,
        outdatedGapMs: input.outdatedGapMs,
      });
      return out;
    }
  }

  /* Pull the surfaced sibling rows: same label, excluding the new
   * session, top-N by started_ms. The preloader doesn't return the
   * full rows so we re-query rather than thread them through the
   * dependency surface. listBrainstorms is DESC by started_ms. */
  const allRows = input.db.listBrainstorms({ limit: 200 });
  const target = label.toLowerCase();
  const siblings = allRows.filter((r) => {
    if (input.excludeId && r.id === input.excludeId) return false;
    return (r.user_label ?? '').trim().toLowerCase() === target;
  });
  const surfaced = siblings.slice(0, forceN > 0 ? Math.max(forceN, 5) : 5);
  out.sibling_count = surfaced.length;

  if (surfaced.length === 0) {
    out.failure_reason = 'no-siblings';
    finalizeContextVerdict({
      summary: out,
      db: input.db,
      anchorId: input.anchorId ?? null,
      siblingRows: null,
      now,
      staleGapMs: input.staleGapMs,
      outdatedGapMs: input.outdatedGapMs,
    });
    return out;
  }

  /* Codex item 5: stale-ref catchup on the label-match path. Each
   * surfaced sibling has its own set of lex_transcript_ref rows; if
   * any are stale, the per-session generator catches them up under
   * the shared budget so the rendered block does not surface a stale
   * [stale] tag the operator has no way to clear. */
  await runLabelMatchStaleCatchup({
    input,
    siblings: surfaced,
    summary: out,
    budgetMs: syncBudgetMs,
    maxRefs: syncMaxRefs,
    now,
  });

  let maxDistilledMs: number | null = null;
  let turns = 0;
  let handoverSourced = 0;
  /* Phase 4 of LEX-STANDALONE-SUPERVISION (2026-05-24): prefer the
   * freshest HANDOVER doc when its mtime beats the row's
   * last_summary_ms. The cold + day-cap grooming passes write the
   * handover; mid-session freshness lives there even when the row's
   * last_summary column has not been refreshed yet. Defaults to
   * findLatestHandover + fs.statSync; tests inject the lookup. */
  const findHandover = input.findHandover ?? defaultFindHandover;
  for (const row of surfaced) {
    const summaryMs =
      row.last_summary_ms && row.last_summary_ms > 0 ? row.last_summary_ms : 0;
    let effectiveMs = summaryMs;
    try {
      const ho = findHandover(row.id);
      if (ho && ho.mtimeMs > effectiveMs) {
        effectiveMs = ho.mtimeMs;
        handoverSourced += 1;
      }
    } catch {
      /* observational; missing handover dir or stat failure must not
       * block the preload */
    }
    if (effectiveMs > 0) {
      if (maxDistilledMs === null || effectiveMs > maxDistilledMs) {
        maxDistilledMs = effectiveMs;
      }
    }
    try {
      turns += input.db.countBrainstormChunks(row.id);
    } catch {
      /* observational; count is a UI surface, never block preload */
    }
  }
  out.last_distilled_ms = maxDistilledMs;
  out.recent_turns_appended = turns;
  out.handover_sourced_count = handoverSourced;
  finalizeContextVerdict({
    summary: out,
    db: input.db,
    anchorId: input.anchorId ?? null,
    siblingRows: surfaced,
    now,
    staleGapMs: input.staleGapMs,
    outdatedGapMs: input.outdatedGapMs,
  });
  return out;
}

/* Wrapper: anchor-refs path catchup. Collects every stale ref under
 * the anchor (excluding the active session), passes them through
 * runStaleRefCatchup, then accumulates the counts onto the
 * preload summary. */
async function runAnchorStaleCatchup(args: {
  input: ColdStartPreloadInput;
  summary: ColdStartPreloadSummary;
  budgetMs: number;
  maxRefs: number;
  now: () => number;
}): Promise<void> {
  const { input, summary } = args;
  if (!input.anchorId) return;
  const refs = input.db.listLexTranscriptRefs(input.anchorId);
  const currentCc = input.currentCcSessionId ?? null;
  const candidates = refs
    .filter((r) => !currentCc || r.cc_session_id !== currentCc)
    .filter((r) => isRefStale(r));
  if (candidates.length === 0) return;
  summary.stale_refs_count = candidates.length;
  if (!input.perSessionGenerator) {
    /* No generator wired (no provider, BF-4 anthropic-block path).
     * Refs stay stale; partial_sync stays false because the spec's
     * partial_sync semantic is "tried but did not catch up", not
     * "could not try at all". The [stale] tag still renders. */
    return;
  }
  try {
    const result = await runStaleRefCatchup({
      db: input.db,
      refs: candidates,
      brainstormIdForRef: () => input.anchorId!,
      perSessionGenerator: input.perSessionGenerator,
      budgetMs: args.budgetMs,
      maxRefs: args.maxRefs,
      now: args.now,
    });
    summary.synced_refs_count = result.synced.length;
    if (result.partial) summary.partial_sync = true;
  } catch {
    summary.partial_sync = true;
  }
}

/* Wrapper: label-match path catchup. For every surfaced sibling row,
 * fetch its lex_transcript_ref rows and run staleness catchup against
 * the union. Shares one budget across all siblings so a single
 * runaway generator call does not starve the next sibling. */
async function runLabelMatchStaleCatchup(args: {
  input: ColdStartPreloadInput;
  siblings: BrainstormSessionRow[];
  summary: ColdStartPreloadSummary;
  budgetMs: number;
  maxRefs: number;
  now: () => number;
}): Promise<void> {
  const { input, siblings, summary } = args;
  if (siblings.length === 0) return;
  const owner = new Map<number, string>();
  const candidates: LexTranscriptRefRow[] = [];
  for (const row of siblings) {
    let refs: LexTranscriptRefRow[];
    try {
      refs = input.db.listLexTranscriptRefs(row.id);
    } catch {
      continue;
    }
    for (const r of refs) {
      if (!isRefStale(r)) continue;
      candidates.push(r);
      owner.set(r.id, row.id);
    }
  }
  if (candidates.length === 0) return;
  summary.stale_refs_count = candidates.length;
  if (!input.perSessionGenerator) return;
  try {
    const result = await runStaleRefCatchup({
      db: input.db,
      refs: candidates,
      brainstormIdForRef: (ref) => owner.get(ref.id) ?? '',
      perSessionGenerator: input.perSessionGenerator,
      budgetMs: args.budgetMs,
      maxRefs: args.maxRefs,
      now: args.now,
    });
    summary.synced_refs_count = result.synced.length;
    if (result.partial) summary.partial_sync = true;
  } catch {
    summary.partial_sync = true;
  }
}

function defaultFindHandover(
  brainstormId: string,
): { mtimeMs: number; filePath: string } | null {
  const latest = findLatestHandover(brainstormId);
  if (!latest) return null;
  try {
    const stat = fs.statSync(latest.filePath);
    return { mtimeMs: stat.mtimeMs, filePath: latest.filePath };
  } catch {
    return null;
  }
}

/* Format the first-turn preamble Lex prints verbatim on its first
 * reply. Auto-generated, not LLM-decided, so the user can trust the
 * counts. Examples:
 *   "Loaded 4 sibling sessions, last distilled 14:32 EDT, 12 recent
 *    turns appended."
 *   "Loaded 1 sibling session, distillation not yet available, 3
 *    recent turns appended."
 *   "Cold start: no prior sibling sessions found." */
export interface FormatPreambleOptions {
  /** TZ-aware label for the distilled timestamp. Defaults to
   * Intl.DateTimeFormat's resolved timezone short name. Tests
   * inject a fixed string so the formatting stays deterministic. */
  timeZoneTag?: string;
  /** Clock for "now" reference (unused today, reserved for future
   * "X minutes ago" formatting). */
  now?: () => Date;
}

export function formatColdStartPreamble(
  summary: ColdStartPreloadSummary,
  opts: FormatPreambleOptions = {},
): string {
  if (summary.sibling_count === 0 && !summary.last_child_session_id) {
    return 'Cold start: no prior sibling sessions found. context_verdict=empty';
  }
  const word = summary.sibling_count === 1 ? 'session' : 'sessions';
  const head = `Loaded ${summary.sibling_count} sibling ${word}`;
  let distilled: string;
  if (summary.last_distilled_ms === null) {
    distilled = 'distillation not yet available';
  } else {
    const d = new Date(summary.last_distilled_ms);
    const tz = opts.timeZoneTag ?? defaultTimeZoneTag();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    distilled = `last distilled ${hh}:${mm}${tz ? ' ' + tz : ''}`;
  }
  const turnWord = summary.recent_turns_appended === 1 ? 'turn' : 'turns';
  const turns = `${summary.recent_turns_appended} recent ${turnWord} appended`;
  /* Fix 55: append the verdict + last child session + lag so Lex's
   * cold-start vetting protocol can quote them back. The verdict is
   * the single token Lex branches on; the supporting numbers are
   * there so a partial / stale / outdated verdict has a "since X"
   * the operator can verify. */
  const verdictLine = `context_verdict=${summary.context_verdict}`;
  const childParts: string[] = [];
  if (summary.last_child_session_title) {
    childParts.push(`last_child=${summary.last_child_session_title}`);
  }
  if (summary.last_child_session_ended_ms !== null) {
    childParts.push(
      `child_ended_ms=${summary.last_child_session_ended_ms}`,
    );
  }
  if (summary.distillation_gap_ms !== null) {
    childParts.push(`distillation_gap_ms=${summary.distillation_gap_ms}`);
  }
  const childLine = childParts.length > 0 ? ` ${childParts.join(' ')}` : '';
  return `${head}, ${distilled}, ${turns}. ${verdictLine}${childLine}`;
}

function defaultTimeZoneTag(): string {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' });
    const parts = fmt.formatToParts(new Date());
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    return tz;
  } catch {
    return '';
  }
}

/* Header status pill copy. Surfaces in the brainstorm UI's header
 * row and reads identically whether the preload succeeded or failed
 * - a red treatment is left to the caller via the failure_reason
 * field. */
export function formatHeaderStatus(
  summary: ColdStartPreloadSummary,
): { tone: 'ok' | 'err'; text: string } {
  if (summary.failure_reason) {
    return {
      tone: 'err',
      text: `context: failed (${summary.failure_reason})`,
    };
  }
  /* Codex item 5: surface freshness barrier counters next to the
   * sibling + turns counts. Net post-sync stale count = stale_refs -
   * synced_refs (the synced ones cleared the [stale] tag). When
   * everything synced, the pill omits the stale_refs suffix so the
   * happy path keeps its existing one-liner. */
  const netStale = Math.max(
    0,
    summary.stale_refs_count - summary.synced_refs_count,
  );
  let staleSuffix = '';
  if (netStale > 0) {
    staleSuffix = `, stale_refs=${netStale}`;
    if (summary.partial_sync) staleSuffix += ' (partial sync)';
  }
  return {
    tone: 'ok',
    text: `context: ${summary.sibling_count} siblings + ${summary.recent_turns_appended} turns${staleSuffix}`,
  };
}

/* Stable JSON-serializable shape for the preload event log surfaced
 * in LexColdStartPreloadPanel. The dashboard groups by brainstorm_id
 * so the panel can render one collapsible card per concurrent
 * session even when several brainstorms are running at the same
 * time. */
export interface PreloadEventLogRow {
  ts: string;
  brainstorm_id: string;
  cc_session_id: string | null;
  sibling_count: number;
  last_distilled_ms: number | null;
  recent_turns_appended: number;
  preloaded_ids: string[];
  already_present_ids: string[];
  failure_reason: string | null;
  preamble: string;
  /* Codex item 6: surface the Fix 42 freshness barrier counters on
   * the event log so the dashboard panel can render the staleness
   * chip without re-deriving from the audit row's JSON reject_reason
   * blob. Defaults to 0/0/false for legacy rows + the no-staleness
   * happy path. */
  stale_refs_count: number;
  synced_refs_count: number;
  partial_sync: boolean;
  /* Fix 55: mirror the new verdict + last-child fields onto the event
   * log shape so the dashboard panel can render them without re-
   * deriving from the audit row's JSON blob. Defaults to verdict='empty'
   * and null last_child_* for legacy rows / non-Fix-55 daemons. */
  context_verdict?: 'fresh' | 'stale' | 'partial' | 'outdated' | 'empty';
  last_child_session_id?: string | null;
  last_child_session_title?: string | null;
  last_child_session_ended_ms?: number | null;
  distillation_gap_ms?: number | null;
}

export function buildPreloadEventLogRow(input: {
  brainstormId: string;
  ccSessionId: string | null;
  summary: ColdStartPreloadSummary;
  preamble: string;
  ts?: string;
}): PreloadEventLogRow {
  return {
    ts: input.ts ?? new Date().toISOString(),
    brainstorm_id: input.brainstormId,
    cc_session_id: input.ccSessionId,
    sibling_count: input.summary.sibling_count,
    last_distilled_ms: input.summary.last_distilled_ms,
    recent_turns_appended: input.summary.recent_turns_appended,
    preloaded_ids: input.summary.preload.preloaded.slice(),
    already_present_ids: input.summary.preload.already_present.slice(),
    failure_reason: input.summary.failure_reason,
    preamble: input.preamble,
    stale_refs_count: input.summary.stale_refs_count,
    synced_refs_count: input.summary.synced_refs_count,
    partial_sync: input.summary.partial_sync,
    context_verdict: input.summary.context_verdict,
    last_child_session_id: input.summary.last_child_session_id,
    last_child_session_title: input.summary.last_child_session_title,
    last_child_session_ended_ms: input.summary.last_child_session_ended_ms,
    distillation_gap_ms: input.summary.distillation_gap_ms,
  };
}

/* Cap the in-memory preload log so a long-running daemon does not
 * unbounded-grow when the panel pings the endpoint. The cap is
 * intentionally generous (500 events) so the panel can group by
 * brainstorm_id and still surface enough history per session. */
export const PRELOAD_EVENT_LOG_CAP = 500;

const preloadEventLog: PreloadEventLogRow[] = [];

/** Append an event row. Called by the cold-start route after the
 * preload completes so the dashboard panel can read it. */
export function recordPreloadEvent(row: PreloadEventLogRow): void {
  preloadEventLog.push(row);
  if (preloadEventLog.length > PRELOAD_EVENT_LOG_CAP) {
    preloadEventLog.splice(0, preloadEventLog.length - PRELOAD_EVENT_LOG_CAP);
  }
}

/** Read the event log, optionally filtered by brainstorm_id so the
 * dashboard can render one card per concurrent session. Returns the
 * most-recent rows first. */
export function listPreloadEvents(opts: {
  brainstormId?: string | null;
  limit?: number;
} = {}): PreloadEventLogRow[] {
  const limit = opts.limit ?? 50;
  const filtered = opts.brainstormId
    ? preloadEventLog.filter((r) => r.brainstorm_id === opts.brainstormId)
    : preloadEventLog.slice();
  return filtered.reverse().slice(0, limit);
}

/** Group all in-memory events by brainstorm_id so the panel can
 * render a multi-session view without re-grouping client-side. */
export function groupPreloadEventsBySession(opts: {
  perSessionLimit?: number;
} = {}): Array<{
  brainstorm_id: string;
  cc_session_id: string | null;
  rows: PreloadEventLogRow[];
}> {
  const perLimit = opts.perSessionLimit ?? 20;
  const groups = new Map<
    string,
    {
      brainstorm_id: string;
      cc_session_id: string | null;
      rows: PreloadEventLogRow[];
    }
  >();
  /* Walk most-recent first so the cc_session_id we surface is the
   * latest known binding for that brainstorm. */
  for (let i = preloadEventLog.length - 1; i >= 0; i--) {
    const row = preloadEventLog[i]!;
    const existing = groups.get(row.brainstorm_id);
    if (existing) {
      if (existing.rows.length < perLimit) existing.rows.push(row);
    } else {
      groups.set(row.brainstorm_id, {
        brainstorm_id: row.brainstorm_id,
        cc_session_id: row.cc_session_id,
        rows: [row],
      });
    }
  }
  return Array.from(groups.values());
}

/** Test seam: clear the in-memory event log between tests. Not
 * exposed via the public surface in production. */
export function _resetPreloadEventLog(): void {
  preloadEventLog.length = 0;
}

/* Surfaced separately so tests can pin the surrounding row shape
 * even without a real brainstorm row. */
export function pickSurfacedSiblings(
  rows: BrainstormSessionRow[],
  label: string,
  excludeId: string | null,
  limit: number,
): BrainstormSessionRow[] {
  const target = label.trim().toLowerCase();
  if (!target) return [];
  const out: BrainstormSessionRow[] = [];
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    if ((row.user_label ?? '').trim().toLowerCase() !== target) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}
