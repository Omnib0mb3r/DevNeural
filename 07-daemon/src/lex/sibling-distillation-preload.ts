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
} from '../store/index-db.js';

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
  const matches = rows.filter((r) => {
    if (exclude && r.id === exclude) return false;
    return normLabel(r.user_label) === target;
  });

  let usedSlots = 0;
  for (const row of matches) {
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
