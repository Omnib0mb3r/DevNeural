/**
 * Distillation staleness watcher (LEX-AUTONOMY codex item 6 / Fix 43).
 *
 * Walks every active brainstorm anchor on a periodic tick, identifies
 * stale lex_transcript_ref rows whose oldest latest_chunk_ms beats the
 * configured threshold T (default DEVNEURAL_STALE_REMINDER_MS, 600_000
 * = 10 min), and emits a notify_class='signal' notification with a
 * per-anchor debounce window (default 30 min) so the bell never sees
 * the same anchor twice inside the window.
 *
 * Bell-only this round per the operator spec; push delivery deferred.
 * `emitNotification` already gates `severity='warn'` through the push
 * pipeline, so passing severity='warn' but push='suppress' keeps the
 * notification in the bell + activity rail without a phone wake.
 *
 * Pure module aside from the emit call: every external dependency
 * (db, clock, emitter) flows through the deps argument so tests can
 * drive the tick deterministically.
 */
import type { IndexDb, BrainstormSessionRow } from '../store/index-db.js';
import { isRefStale } from './lex-transcript-ref.js';

export interface StaleWatchDeps {
  db: IndexDb;
  /** Brainstorm row enumerator. Defaults to listBrainstorms({status:'active'}). */
  listActive?: () => BrainstormSessionRow[];
  /** Notification emit hook. Defaults to the real emitNotification. */
  emit?: (input: {
    severity: 'info' | 'warn' | 'alert';
    source: string;
    title: string;
    body?: string;
    link?: string;
    notify_class?: 'conversation' | 'report' | 'followup' | 'signal';
    push?: 'auto' | 'force' | 'suppress';
    push_data?: Record<string, string | number | boolean | null>;
  }) => { id: string } | void;
  /** Clock. */
  now?: () => number;
  /** Threshold past which staleness fires the reminder, in ms.
   * Defaults to DEVNEURAL_STALE_REMINDER_MS env or 600_000. */
  thresholdMs?: number;
  /** Per-anchor cooldown between consecutive emits. Default 30 min. */
  debounceMs?: number;
  /** Per-anchor last-fired-ms map. Production passes the daemon's
   * module-level Map; tests pass a fresh one. */
  state?: Map<string, number>;
  log?: (msg: string) => void;
}

export interface StaleWatchTickResult {
  evaluated: number;
  fired: string[];
  skipped_debounced: string[];
  skipped_fresh: string[];
}

const DEFAULT_THRESHOLD_MS = 600_000; // 10 minutes
const DEFAULT_DEBOUNCE_MS = 30 * 60_000; // 30 minutes

export function runStaleWatchTick(
  deps: StaleWatchDeps,
): StaleWatchTickResult {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const envThreshold = Number(process.env.DEVNEURAL_STALE_REMINDER_MS);
  const threshold =
    deps.thresholdMs ??
    (Number.isFinite(envThreshold) && envThreshold > 0
      ? envThreshold
      : DEFAULT_THRESHOLD_MS);
  const debounce = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const state = deps.state ?? new Map<string, number>();
  const listActive =
    deps.listActive ??
    (() => deps.db.listBrainstorms({ status: 'active', limit: 200 }));
  const result: StaleWatchTickResult = {
    evaluated: 0,
    fired: [],
    skipped_debounced: [],
    skipped_fresh: [],
  };
  const emit = deps.emit ?? defaultEmit;
  const tNow = now();
  for (const b of listActive()) {
    result.evaluated += 1;
    let refs;
    try {
      refs = deps.db.listLexTranscriptRefs(b.id);
    } catch {
      continue;
    }
    let staleCount = 0;
    let totalCount = refs.length;
    let oldestLatestMs: number | null = null;
    for (const r of refs) {
      if (!isRefStale(r)) continue;
      staleCount += 1;
      if (
        r.latest_chunk_ms !== null &&
        (oldestLatestMs === null || r.latest_chunk_ms < oldestLatestMs)
      ) {
        oldestLatestMs = r.latest_chunk_ms;
      }
    }
    if (staleCount === 0 || oldestLatestMs === null) {
      result.skipped_fresh.push(b.id);
      continue;
    }
    const ageMs = tNow - oldestLatestMs;
    if (ageMs < threshold) {
      /* Stale but inside the threshold; informational, no emit. */
      result.skipped_fresh.push(b.id);
      continue;
    }
    const lastFired = state.get(b.id) ?? 0;
    if (lastFired > 0 && tNow - lastFired < debounce) {
      result.skipped_debounced.push(b.id);
      continue;
    }
    state.set(b.id, tNow);
    const label = b.user_label ?? b.derived_label ?? b.id.slice(0, 8);
    const ageStr = humanAge(ageMs);
    try {
      emit({
        severity: 'warn',
        source: 'staleness-watch',
        notify_class: 'signal',
        title: `Distillation stale: ${label}`,
        body: `${staleCount} of ${totalCount} refs unrefreshed (oldest chunk ${ageStr} ago). Lex prior-session context may be partial until catchup runs.`,
        link: `/brainstorms/${encodeURIComponent(b.id)}`,
        push: 'suppress',
        push_data: {
          brainstorm_id: b.id,
          stale_count: staleCount,
          total_count: totalCount,
          oldest_chunk_ms: oldestLatestMs,
        },
      });
      result.fired.push(b.id);
      log(
        `[stale-watch] fired anchor=${b.id.slice(0, 8)} stale=${staleCount}/${totalCount} age=${ageStr}`,
      );
    } catch (err) {
      log(`[stale-watch] emit failed: ${(err as Error).message}`);
    }
  }
  return result;
}

async function defaultEmit(
  input: Parameters<NonNullable<StaleWatchDeps['emit']>>[0],
): Promise<{ id: string } | void> {
  try {
    const mod = await import('../dashboard/notifications.js');
    return mod.emitNotification(input);
  } catch {
    return;
  }
}

function humanAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export interface StartStaleWatchOptions {
  deps: StaleWatchDeps;
  intervalMs?: number;
  scheduler?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

export const DEFAULT_STALE_WATCH_INTERVAL_MS = 5 * 60_000;

export interface StaleWatchHandle {
  stop(): void;
  tickNow(): StaleWatchTickResult;
}

export function startStaleWatch(
  opts: StartStaleWatchOptions,
): StaleWatchHandle {
  const interval = opts.intervalMs ?? DEFAULT_STALE_WATCH_INTERVAL_MS;
  const sched =
    opts.scheduler ?? {
      set: (fn, ms) => setInterval(fn, ms),
      clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  /* Production debounce state lives across ticks. */
  const state = opts.deps.state ?? new Map<string, number>();
  const deps: StaleWatchDeps = { ...opts.deps, state };
  let inFlight = false;
  const tick = (): StaleWatchTickResult => {
    if (inFlight) {
      return {
        evaluated: 0,
        fired: [],
        skipped_debounced: [],
        skipped_fresh: [],
      };
    }
    inFlight = true;
    try {
      return runStaleWatchTick(deps);
    } finally {
      inFlight = false;
    }
  };
  const handle = sched.set(() => {
    tick();
  }, interval);
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }
  return {
    stop: () => sched.clear(handle),
    tickNow: tick,
  };
}
