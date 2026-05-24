/**
 * Idle-watcher (Phase 2 of LEX-STANDALONE-SUPERVISION).
 *
 * Scans every brainstorm row with lifecycle_state IN ('idle',
 * 'attached') on a fixed cadence (default 60s). For each row,
 * computes how long it has been silent since the last user turn and
 * fires the appropriate grooming pass (light / mid / cold /
 * day-cap). 'speaking' rows are skipped because the user turn is
 * sacred; 'ended' rows are terminal.
 *
 * decidePendingPass (in grooming.ts) is the pure decision; this
 * module is the scheduler that wraps it. Single-flight per
 * brainstorm id: if a previous tick's pass is still running, the
 * next tick observes the in-flight flag and skips, so a slow LLM
 * call cannot pile up concurrent passes against the same row.
 */
import type { IndexDb } from '../store/index-db.js';
import {
  decidePendingPass,
  runGroomingPass,
  type GroomingDeps,
  type GroomingKind,
  type GroomingResult,
} from './grooming.js';

export const DEFAULT_IDLE_WATCHER_INTERVAL_MS = 60_000;

export interface IdleWatcherDeps extends GroomingDeps {
  db: IndexDb;
  /** Override the tick cadence for tests. */
  intervalMs?: number;
  /** Scheduler seam. Defaults to setInterval / clearInterval. */
  scheduler?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

export interface IdleWatcherHandle {
  stop(): void;
  /** Drive a tick synchronously; tests use this instead of waiting
   * for setInterval. Returns the per-row results. */
  tickNow(): Promise<GroomingResult[]>;
}

export interface IdleWatcherTickStats {
  scanned: number;
  fired: number;
  skipped_in_flight: number;
}

export function startIdleWatcher(deps: IdleWatcherDeps): IdleWatcherHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_IDLE_WATCHER_INTERVAL_MS;
  const log = deps.log ?? (() => undefined);
  const sched =
    deps.scheduler ?? {
      set: (fn, ms) => setInterval(fn, ms),
      clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  const inFlight = new Set<string>();

  async function tick(): Promise<GroomingResult[]> {
    const now = (deps.now ?? Date.now)();
    /* Pull idle + attached rows. The watcher does not act on
     * 'speaking' (user turn sacred) or 'ended' (terminal). */
    const idleRows = deps.db.listBrainstorms({
      lifecycle_state: 'idle',
      limit: 200,
    });
    const attachedRows = deps.db.listBrainstorms({
      lifecycle_state: 'attached',
      limit: 200,
    });
    const rows = idleRows.concat(attachedRows);
    const results: GroomingResult[] = [];
    let fired = 0;
    let skippedInFlight = 0;
    for (const row of rows) {
      const decision = decidePendingPass(row, now);
      if (!decision.kind) continue;
      if (inFlight.has(row.id)) {
        skippedInFlight += 1;
        continue;
      }
      inFlight.add(row.id);
      fired += 1;
      try {
        const result = await runGroomingPass(decision.kind, row.id, deps);
        results.push(result);
      } catch (err) {
        log(
          `[idle-watcher] brainstorm=${row.id} kind=${decision.kind} threw: ${(err as Error).message}`,
        );
      } finally {
        inFlight.delete(row.id);
      }
    }
    if (fired > 0 || skippedInFlight > 0) {
      log(
        `[idle-watcher] tick scanned=${rows.length} fired=${fired} skipped_in_flight=${skippedInFlight}`,
      );
    }
    return results;
  }

  const handle = sched.set(() => {
    void tick();
  }, intervalMs);
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }
  return {
    stop: () => sched.clear(handle),
    tickNow: tick,
  };
}

/* Convenience helper exposed for the dashboard "Standalone brainstorm
 * idle activity" panel: walks the same rows the watcher does and
 * surfaces (silence + pending-pass) without firing anything. The
 * dashboard route imports this and the panel renders one row per
 * entry. Pure read; no side effects. */
export interface IdleActivityRow {
  brainstormId: string;
  user_label: string | null;
  lifecycle_state: 'idle' | 'attached';
  runtime_mode: 'cc-pty' | 'direct-llm' | 'detached' | null;
  last_user_utterance_at: string | null;
  last_grooming_pass_at: string | null;
  last_grooming_kind: GroomingKind | null;
  silence_ms: number;
  baseline_ms: number;
  pending_pass: GroomingKind | null;
}

export function listIdleActivity(
  db: IndexDb,
  nowMs: number = Date.now(),
): IdleActivityRow[] {
  const idle = db.listBrainstorms({ lifecycle_state: 'idle', limit: 200 });
  const attached = db.listBrainstorms({
    lifecycle_state: 'attached',
    limit: 200,
  });
  const rows = idle.concat(attached);
  const out: IdleActivityRow[] = [];
  for (const row of rows) {
    const decision = decidePendingPass(row, nowMs);
    out.push({
      brainstormId: row.id,
      user_label: row.user_label ?? null,
      lifecycle_state:
        (row.lifecycle_state as 'idle' | 'attached') ?? 'idle',
      runtime_mode: (row.runtime_mode ?? null) as
        | 'cc-pty'
        | 'direct-llm'
        | 'detached'
        | null,
      last_user_utterance_at: row.last_user_utterance_at ?? null,
      last_grooming_pass_at: row.last_grooming_pass_at ?? null,
      last_grooming_kind: (row.last_grooming_kind ?? null) as GroomingKind | null,
      silence_ms: decision.silenceMs,
      baseline_ms: decision.baselineMs,
      pending_pass: decision.kind,
    });
  }
  out.sort((a, b) => b.silence_ms - a.silence_ms);
  return out;
}
