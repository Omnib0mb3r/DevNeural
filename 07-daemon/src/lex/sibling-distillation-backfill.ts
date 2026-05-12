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
}

export interface BackfillResult {
  processed: string[];
  skipped: string[];
  /** Rows the generator failed or returned empty on. */
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

  for (const row of candidates) {
    if (out.processed.length >= limit) {
      out.hit_cap = candidates.length > out.processed.length;
      out.skipped.push(row.id);
      continue;
    }
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
      out.processed.push(row.id);
    } else {
      out.errors.push(row.id);
    }
  }

  return out;
}
