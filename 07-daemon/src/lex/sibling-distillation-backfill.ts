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
} from '../store/index-db.js';
import type { DistillationGenerator } from './sibling-distillation-preload.js';

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
    if (looksLikeSelfAudit(r)) return false;
    if (target && normLabel(r.user_label) !== target) return false;
    return true;
  });

  /* Pre-filter chunkless brainstorms. Sessions older than the
   * brainstorm_chunks table have no transcript rows; the generator
   * would skip them ("[distill-gen] no chunks for <id>") and return
   * null, which the old bucketing classified as a failure. Treat
   * them as skipped so the scheduler summary distinguishes "no
   * content" from a real LLM / DB / generation error. Pre-filtering
   * also avoids burning a provider call per chunkless candidate. */
  const chunked: BrainstormSessionRow[] = [];
  let chunklessSkipCount = 0;
  for (const row of candidates) {
    if (opts.db.countBrainstormChunks(row.id) === 0) {
      out.skipped.push(row.id);
      chunklessSkipCount += 1;
      continue;
    }
    chunked.push(row);
  }
  if (chunklessSkipCount > 0 && opts.log) {
    opts.log(
      `[distill-backfill] skipped ${chunklessSkipCount} chunkless brainstorm${
        chunklessSkipCount === 1 ? '' : 's'
      }`,
    );
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
      opts.db.updateBrainstorm(row.id, {
        last_summary: distillation.trim(),
        last_summary_ms: now(),
      });
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
