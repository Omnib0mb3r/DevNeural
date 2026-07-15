/**
 * Always-on lint queue.
 *
 * The brain doesn't go offline waiting for a weekly cron. Every ingest that
 * creates or updates a page schedules a lint pass through this queue.
 * Debounced (60s default) so a flurry of activity rolls into one lint cycle
 * instead of thrashing the LLM. Single-flight so concurrent triggers don't
 * stack work; the debounce window collapses every additional schedule into
 * the existing pending tick.
 *
 * After lint applies, whats-new gets regenerated and decay runs, so
 * reinforcement signals stay current too. The result: the dashboard's
 * Daily Brief and the wiki graph reflect new insights minutes after the
 * session that produced them, not weeks later.
 *
 * Wired by daemon.ts at startup via initLintQueue(store, log). Anything
 * that touches wiki pages calls scheduleLint(reason) to bump the debounce.
 */
import * as fs from 'node:fs';
import type { Store } from '../store/index.js';
import { runLint } from './lint.js';
import { generateWhatsNew } from './whats-new.js';
import { decayInactivePages } from '../reinforcement/index.js';
import { wikiWhatsNewFile } from '../paths.js';

const WHATS_NEW_STALE_MS = 24 * 60 * 60 * 1000; // 24h

/** True when whats-new.md hasn't been regenerated in 24h+ (or has never
 * been generated at all). Checked against file mtime rather than a
 * module-level timestamp so the staleness signal survives a daemon
 * restart -- a quiet wiki shouldn't get an immediate regen just because
 * the process happened to restart. */
function whatsNewIsStale(): boolean {
  try {
    const stat = fs.statSync(wikiWhatsNewFile());
    return Date.now() - stat.mtimeMs >= WHATS_NEW_STALE_MS;
  } catch {
    return true;
  }
}

interface QueueState {
  store: Store;
  log: (msg: string) => void;
  /** Pending debounce timer; scheduleLint resets it if called again. */
  timer: NodeJS.Timeout | null;
  /** True while a lint cycle is in flight. Concurrent schedules during a
   * cycle queue exactly one rerun by setting rerunRequested. */
  running: boolean;
  rerunRequested: boolean;
  /** Reasons accumulated during the debounce window, surfaced in the log
   * line when the cycle fires so the user can see what triggered it. */
  reasons: Set<string>;
  debounceMs: number;
  /** Last completion time, exposed for /health and debugging. */
  lastRunAt: string | null;
}

let state: QueueState | null = null;

export function initLintQueue(
  store: Store,
  log: (msg: string) => void,
  opts: { debounceMs?: number } = {},
): void {
  state = {
    store,
    log,
    timer: null,
    running: false,
    rerunRequested: false,
    reasons: new Set(),
    debounceMs: opts.debounceMs ?? Number(process.env.DEVNEURAL_LINT_DEBOUNCE_MS ?? 60_000),
    lastRunAt: null,
  };
  log(`[lint-queue] ready, debounce=${state.debounceMs}ms`);
}

export function scheduleLint(reason: string): void {
  if (!state) return;
  state.reasons.add(reason);
  if (state.running) {
    // A cycle is already running; mark for rerun so freshly-touched pages
    // get a follow-up lint after this cycle finishes.
    state.rerunRequested = true;
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    void cycle();
  }, state.debounceMs);
}

async function cycle(): Promise<void> {
  if (!state) return;
  if (state.running) return;
  state.running = true;
  state.timer = null;
  const reasons = Array.from(state.reasons).join(',');
  state.reasons.clear();
  const log = state.log;

  try {
    log(`[lint-queue] cycle start, reasons=${reasons}`);
    const lintResult = await runLint({ apply: true });
    log(
      `[lint-queue] lint applied: scanned=${lintResult.scanned} actions=${lintResult.actions.length}`,
    );

    // Reinforcement decay + whats-new normally only run when lint actually
    // made changes; otherwise we'd be writing decayed weights every minute
    // even on quiet wikis. But a wiki can stay quiet (zero actions) for
    // longer than the Daily Brief should go stale, so a cycle that finds
    // nothing to lint still forces a refresh once whats-new.md has passed
    // its 24h staleness window -- e.g. after a long period the watcher
    // itself was dead upstream and lint has nothing new to say yet.
    const hadActions = lintResult.actions.length > 0;
    const staleRefresh = !hadActions && whatsNewIsStale();
    if (hadActions || staleRefresh) {
      try {
        const decayResult = await decayInactivePages(state.store, log);
        log(
          `[lint-queue] decay: decayed=${decayResult.decayed} archived=${decayResult.archived}`,
        );
      } catch (err) {
        log(`[lint-queue] decay failed: ${(err as Error).message}`);
      }

      // Refresh the whats-new digest so the dashboard's Daily Brief
      // reflects the new state within the lint cadence.
      try {
        generateWhatsNew(7);
        log(
          `[lint-queue] whats-new regenerated${staleRefresh ? ' (quiet cycle, 24h staleness refresh)' : ''}`,
        );
      } catch (err) {
        log(`[lint-queue] whats-new failed: ${(err as Error).message}`);
      }
    }

    state.lastRunAt = new Date().toISOString();
  } catch (err) {
    log(`[lint-queue] cycle failed: ${(err as Error).message}`);
  } finally {
    state.running = false;
    if (state.rerunRequested) {
      state.rerunRequested = false;
      // Schedule another debounced cycle. Reasons accumulated during this
      // run are already in state.reasons; the next cycle will surface them.
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        void cycle();
      }, state.debounceMs);
    }
  }
}

export function lintQueueStatus(): {
  ready: boolean;
  running: boolean;
  pending: boolean;
  last_run_at: string | null;
  debounce_ms: number;
  pending_reasons: string[];
} {
  if (!state) {
    return {
      ready: false,
      running: false,
      pending: false,
      last_run_at: null,
      debounce_ms: 0,
      pending_reasons: [],
    };
  }
  return {
    ready: true,
    running: state.running,
    pending: state.timer !== null,
    last_run_at: state.lastRunAt,
    debounce_ms: state.debounceMs,
    pending_reasons: Array.from(state.reasons),
  };
}
