/**
 * Sibling distillation backfill job.
 *
 * Phase 2 of the sibling-distillation rollout. The preloader covers
 * the top 2 most-recent siblings at spawn time so the user always
 * sees a fresh sibling block. Everything older is filled in by this
 * job, capped at N=5 rows per run so a cold start cannot cascade
 * into a flood of LLM calls.
 *
 * Pure module: generator + clock are injected; tests verify the cap
 * and per-row behaviour without touching ollama or anthropic.
 *
 * Selection order: most-recent first (started_ms DESC) so a row that
 * just shipped its session-end distillation but is still missing
 * last_summary (race / failure) gets caught on the very next run.
 */
import type {
  BrainstormSessionRow,
  IndexDb,
  LexTranscriptRefRow,
} from '../store/index-db.js';
import type { DistillationGenerator } from './sibling-distillation-preload.js';
import { hasDistillableJsonlSource } from './jsonl-transcript-reader.js';
import { isRefStale } from './lex-transcript-ref.js';

export interface BackfillOptions {
  db: IndexDb;
  generator: DistillationGenerator;
  /** Per-run cap. Default 5. */
  limit?: number;
  /** Restrict to brainstorm_sessions whose user_label matches.
   * Optional: omit to backfill every label. */
  label?: string | null;
  /** Exclude a specific brainstorm id (e.g. the new spawn the
   * preloader is already working). */
  excludeId?: string | null;
  /** Clock for the last_summary_ms stamp. */
  now?: () => number;
  /** Optional logger so the chunkless-skip summary lands in the same
   * stream the scheduler uses for its tick summary. */
  log?: (msg: string) => void;
}

export interface BackfillResult {
  processed: string[];
  /** Rows that cannot or will not be distilled this tick: chunkless
   * brainstorms (older than the brainstorm_chunks table) AND
   * candidates the per-run cap pushed past. The two are merged into
   * one bucket because both are "not failures, try later" from the
   * caller's perspective. */
  skipped: string[];
  /** Rows the generator threw on or returned empty for AFTER reaching
   * a transcript. Chunkless rows are NOT counted as errors; without
   * chunks there is no transcript to distill in the first place, so
   * bucketing them as failures was misclassifying daemon log noise. */
  errors: string[];
  /** True when the cap stopped the run before all candidates were
   * exhausted, so the caller can schedule another tick. */
  hit_cap: boolean;
}

export const BACKFILL_DEFAULT_LIMIT = 5;

function normLabel(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

function isEmpty(s: string | null | undefined): boolean {
  return !s || s.trim().length === 0;
}

function looksLikeSelfAudit(row: BrainstormSessionRow): boolean {
  /* The audit-doc-ingest path writes last_summary directly without
   * an LLM call. Those rows already have a summary; this guard is
   * belt + suspenders so a future caller that filters differently
   * cannot accidentally re-distill them. */
  return !isEmpty(row.last_summary);
}

/* The child lex_transcript_ref rows for a brainstorm that are stale by
 * the freshness barrier (latest_chunk_ms > ref_summary_ms, per
 * isRefStale). Used for BOTH selection (a summarized row with a stale
 * ref must re-distill) and the post-distill stamp (flip each stale
 * ref's ref_summary_ms so isRefStale -> false). Best-effort: a missing
 * migration / dropped table yields no stale refs rather than throwing,
 * matching the rest of the backfill's degrade-quietly posture. */
function staleRefsFor(
  db: IndexDb,
  brainstormId: string,
): LexTranscriptRefRow[] {
  let refs: LexTranscriptRefRow[];
  try {
    refs = db.listLexTranscriptRefs(brainstormId);
  } catch {
    return [];
  }
  return refs.filter(isRefStale);
}

export async function runDistillationBackfill(
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const limit = opts.limit ?? BACKFILL_DEFAULT_LIMIT;
  const now = opts.now ?? Date.now;
  const out: BackfillResult = {
    processed: [],
    skipped: [],
    errors: [],
    hit_cap: false,
  };

  /* Over-fetch and filter client-side: the table is small enough
   * that an indexed query is not worth a migration. listBrainstorms
   * returns DESC by started_ms. */
  const rows = opts.db.listBrainstorms({ limit: 1000 });
  const target = opts.label ? normLabel(opts.label) : null;
  const exclude = opts.excludeId ?? null;
  const candidates = rows.filter((r) => {
    if (exclude && r.id === exclude) return false;
    if (target && normLabel(r.user_label) !== target) return false;
    /* Unsummarized rows are candidates as before. Summarized rows used
     * to be dropped outright (looksLikeSelfAudit), which is the bug:
     * the writer keyed on last_summary PRESENCE while the reader
     * (isRefStale) keys on TIMESTAMP, so a once-distilled long-running
     * anchor whose child sessions kept appending chunks never
     * re-distilled. Keep a summarized row when any child ref is stale
     * so staleness, not presence, drives selection. The DB hit only
     * happens for already-summarized rows that survived the cheap
     * exclude/label filters. */
    if (!looksLikeSelfAudit(r)) return true;
    return staleRefsFor(opts.db, r.id).length > 0;
  });

  /* Pre-filter brainstorms with no distillable source. Chunkless
   * sessions used to be hard-skipped here; now we accept them if
   * lex_transcript_ref resolves to readable jsonl files on disk
   * (the generator falls back to that path). Skip only when BOTH
   * sources are empty so the scheduler summary still distinguishes
   * "no content" from a real provider / generation error. */
  const chunked: BrainstormSessionRow[] = [];
  let chunklessSkipCount = 0;
  let jsonlFallbackCount = 0;
  for (const row of candidates) {
    const hasChunks = opts.db.countBrainstormChunks(row.id) > 0;
    if (hasChunks) {
      chunked.push(row);
      continue;
    }
    if (hasDistillableJsonlSource(opts.db, row.id)) {
      chunked.push(row);
      jsonlFallbackCount += 1;
      continue;
    }
    out.skipped.push(row.id);
    chunklessSkipCount += 1;
  }
  if (opts.log) {
    if (jsonlFallbackCount > 0) {
      opts.log(
        `[distill-backfill] ${jsonlFallbackCount} chunkless brainstorm${
          jsonlFallbackCount === 1 ? '' : 's'
        } eligible via jsonl fallback`,
      );
    }
    if (chunklessSkipCount > 0) {
      opts.log(
        `[distill-backfill] skipped ${chunklessSkipCount} brainstorm${
          chunklessSkipCount === 1 ? '' : 's'
        } with no chunks and no jsonl refs`,
      );
    }
  }

  for (const row of chunked) {
    if (out.processed.length >= limit) {
      out.hit_cap = chunked.length > out.processed.length;
      out.skipped.push(row.id);
      continue;
    }
    let distillation: string | null = null;
    let threw = false;
    try {
      distillation = await opts.generator(row);
    } catch {
      distillation = null;
      threw = true;
    }
    if (distillation && distillation.trim().length > 0) {
      const ts = now();
      opts.db.updateBrainstorm(row.id, {
        last_summary: distillation.trim(),
        last_summary_ms: ts,
      });
      /* Flip the freshness barrier alongside last_summary_ms. The
       * re-distill above read the row's current transcript, which
       * already includes the chunks that landed after each stale ref's
       * last per-ref distill, so stamping ref_summary_ms here is
       * honest. Without it the reader (isRefStale) and writer
       * (last_summary presence) stay out of sync and the stale tag
       * never clears. Fresh refs are left untouched; the same-`ts`
       * stamp keeps ref_summary_ms >= latest_chunk_ms for every ref. */
      for (const ref of staleRefsFor(opts.db, row.id)) {
        opts.db.updateLexTranscriptRef(ref.id, { ref_summary_ms: ts });
      }
      out.processed.push(row.id);
    } else {
      /* Real failure: the row had a transcript but the generator
       * threw or returned empty. Bucket as error so the summary
       * still surfaces genuine provider / generation problems. */
      void threw;
      out.errors.push(row.id);
    }
  }

  return out;
}
