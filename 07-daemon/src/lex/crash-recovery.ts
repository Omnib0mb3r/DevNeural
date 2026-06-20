/* Crash recovery (sliver 4, 2026-06-19).
 *
 * On a crash the daemon dies mid-session and the normal end-of-session
 * pass (distill + handoff) never runs. On the next boot this module
 * detects the gap and runs the missed pass, so the distillations + docs
 * catch up to what actually happened before the crash.
 *
 * Detection reuses the staleness signal, anchored to the last clean
 * checkpoint:
 *
 *   lastCleanMs      = max(newest cold-start report ms, last_summary_ms)
 *   latestActivityMs = max latest_chunk_ms across the anchor's refs
 *   gap              = latestActivityMs > lastCleanMs
 *
 * The newest cold-start report ms is the last-clean-boot marker sliver 3
 * persists; chunks that landed after it were never checkpointed. A clean
 * shutdown bumps last_summary_ms past the latest chunk, so it leaves no
 * gap. A crash leaves activity stranded past both markers -> gap.
 *
 * At boot time "a gap" and "a crash gap" are the same thing: the
 * checkpoint/end-of-session pass for that gap never ran. Recovering it is
 * idempotent (re-distill overwrites deterministically), so a false
 * positive on a soon-to-be-live anchor is harmless.
 *
 * The recovery action is runDistillationFlush - the non-terminal
 * session-end pass (no status flip) - so a still-alive anchor is not
 * prematurely ended. It routes through the shared engine selectors, so
 * DEVNEURAL_DISTILL_HEADLESS is respected (ollama by default).
 */
import type { IndexDb } from '../store/index-db.js';
import type { Store } from '../store/index.js';
import { isRefStale } from './lex-transcript-ref.js';
import { readLatestColdStartReport } from './cold-start-report.js';

export interface CrashGap {
  anchorId: string;
  /** True when activity landed after the last clean checkpoint. */
  crashed: boolean;
  /** max(newest cold-start report ms, last_summary_ms). */
  lastCleanMs: number;
  /** max latest_chunk_ms across the anchor's refs (0 when none). */
  latestActivityMs: number;
  /** Stale refs by the freshness barrier (informational). */
  staleRefCount: number;
}

export function detectCrashGap(db: IndexDb, anchorId: string): CrashGap {
  let lastSummaryMs = 0;
  try {
    const bs = db.getBrainstorm(anchorId) as
      | { last_summary_ms?: number | null }
      | undefined;
    lastSummaryMs = bs?.last_summary_ms ?? 0;
  } catch {
    lastSummaryMs = 0;
  }
  let reportMs = 0;
  try {
    reportMs = readLatestColdStartReport(db, anchorId)?.ms ?? 0;
  } catch {
    reportMs = 0;
  }
  const lastCleanMs = Math.max(lastSummaryMs, reportMs);

  let latestActivityMs = 0;
  let staleRefCount = 0;
  try {
    for (const ref of db.listLexTranscriptRefs(anchorId)) {
      if (ref.latest_chunk_ms !== null && ref.latest_chunk_ms > latestActivityMs) {
        latestActivityMs = ref.latest_chunk_ms;
      }
      if (isRefStale(ref)) staleRefCount += 1;
    }
  } catch {
    /* missing migration / dropped table -> no activity observed */
  }

  const crashed = latestActivityMs > 0 && latestActivityMs > lastCleanMs;
  return { anchorId, crashed, lastCleanMs, latestActivityMs, staleRefCount };
}

export interface RecoverCrashedOptions {
  store: Store;
  log?: (msg: string) => void;
  /** Max anchors to recover this sweep. Default 10; 0 disables. */
  limit?: number;
  /** Test seam: candidate anchors. Default active brainstorms. */
  listAnchors?: () => { id: string }[];
  /** Test seam: gap detector. Default detectCrashGap(store.db). */
  detect?: (anchorId: string) => CrashGap;
  /** Test seam: recover one anchor. Default runs the missed
   * (non-terminal) session-end distill flush. */
  recover?: (gap: CrashGap) => Promise<void>;
}

export interface RecoverCrashedResult {
  scanned: number;
  recovered: string[];
  /** Crashed anchors the cap pushed past this sweep. */
  skipped_cap: number;
}

export async function recoverCrashedAnchors(
  opts: RecoverCrashedOptions,
): Promise<RecoverCrashedResult> {
  const log = opts.log ?? (() => undefined);
  const limit = opts.limit ?? 10;
  const out: RecoverCrashedResult = {
    scanned: 0,
    recovered: [],
    skipped_cap: 0,
  };
  if (limit <= 0) {
    log('[crash-recovery] disabled (limit=0)');
    return out;
  }
  const listAnchors =
    opts.listAnchors ??
    (() =>
      opts.store.db
        .listBrainstorms({ status: 'active', limit: 1000 })
        .map((r) => ({ id: r.id })));
  const detect =
    opts.detect ?? ((anchorId: string) => detectCrashGap(opts.store.db, anchorId));
  const recover = opts.recover ?? defaultRecover(opts.store, log);

  let anchors: { id: string }[];
  try {
    anchors = listAnchors();
  } catch (err) {
    log(`[crash-recovery] listAnchors failed: ${(err as Error).message}`);
    return out;
  }

  for (const a of anchors) {
    out.scanned += 1;
    let gap: CrashGap;
    try {
      gap = detect(a.id);
    } catch (err) {
      log(`[crash-recovery] detect failed for ${a.id.slice(0, 8)}: ${(err as Error).message}`);
      continue;
    }
    if (!gap.crashed) continue;
    if (out.recovered.length >= limit) {
      out.skipped_cap += 1;
      continue;
    }
    try {
      await recover(gap);
      out.recovered.push(a.id);
      log(
        `[crash-recovery] recovered ${a.id.slice(0, 8)} gap_after=${gap.lastCleanMs} latest=${gap.latestActivityMs} stale_refs=${gap.staleRefCount}`,
      );
    } catch (err) {
      log(
        `[crash-recovery] recover failed for ${a.id.slice(0, 8)}: ${(err as Error).message}`,
      );
    }
  }
  if (out.skipped_cap > 0) {
    log(
      `[crash-recovery] ${out.skipped_cap} crashed anchor(s) past the cap (limit=${limit}); next boot sweep will catch them`,
    );
  }
  log(
    `[crash-recovery] sweep done scanned=${out.scanned} recovered=${out.recovered.length} skipped_cap=${out.skipped_cap}`,
  );
  return out;
}

/* Default recovery: run the missed end-of-session distill flush
 * (non-terminal: no status flip, so a still-alive anchor is not ended).
 * Dynamic import keeps the heavy session-end module out of this file's
 * static graph. */
function defaultRecover(
  store: Store,
  log: (msg: string) => void,
): (gap: CrashGap) => Promise<void> {
  return async (gap: CrashGap) => {
    const bs = store.db.getBrainstorm(gap.anchorId) as
      | { claude_session_id?: string | null; mode?: string }
      | undefined;
    const { runDistillationFlush } = await import('./session-end-pipeline.js');
    await runDistillationFlush(
      store,
      {
        brainstormId: gap.anchorId,
        claudeSessionId: bs?.claude_session_id ?? null,
        mode: bs?.mode ?? 'conversation',
        reason: 'crash-recovery',
      },
      log,
    );
  };
}
