/**
 * Pending-distillation tracker (FIXES.md SM-23).
 *
 * Three defects this closes:
 *
 *  1. The dashboard End button hung: POST /lex/anchors/:id/end
 *     awaited the FULL session-end pipeline inline (distillation is
 *     a headless LLM run, 90s+ observed live, 180s timeout cap), so
 *     the HTTP request - and the UI behind it - sat blocked for
 *     minutes. End paths now QUEUE the pipeline through here and
 *     return immediately.
 *
 *  2. Nothing survived a daemon restart: a pipeline killed mid-run
 *     (or never started because the process died first) left the
 *     brainstorm's last_summary stale with no record that
 *     distillation was still owed. A file marker under
 *     <DATA_ROOT>/lex/distill-pending/<brainstormId>.json now
 *     persists the owed work until the pipeline completes.
 *
 *  3. Restart-before-distill served stale context: a new session on
 *     the same anchor cold-started against the OLD last_summary.
 *     The cold-start-preload route calls awaitPendingDistill()
 *     before building its block, forcing the owed distillation to
 *     run (bounded) so a true cold start waits for fresh context -
 *     the only path where the added latency is acceptable, per the
 *     operator's spec.
 *
 * Race safety: runSessionEndPipeline already serializes concurrent
 * callers per session via withSessionEndLock; the in-flight map here
 * only exists so awaiters can join the SAME promise (and so a forced
 * re-run is not started while one is running). Node is single-
 * threaded, so map check + set is atomic per tick. Bounded waits:
 * the awaited path races against DISTILL_AWAIT_CAP_MS and proceeds
 * loudly on timeout - a stale preload beats a hung session start.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_ROOT, ensureDir } from '../paths.js';
import {
  runSessionEndPipeline,
  type SessionEndInput,
  type SessionEndResult,
} from './session-end-pipeline.js';
import type { Store } from '../store/index.js';

export const DISTILL_AWAIT_CAP_MS = Number(
  process.env.DEVNEURAL_DISTILL_AWAIT_CAP_MS ?? 150_000,
);

export interface PendingDistillMarker {
  brainstorm_id: string;
  claude_session_id: string | null;
  mode: string;
  reason: string;
  queued_ms: number;
  /** Stamped when a run failed; the marker survives so the next
   * cold start retries the distillation. */
  last_error?: string;
  last_error_ms?: number;
}

export interface AwaitPendingResult {
  outcome: 'none' | 'completed' | 'timeout' | 'failed';
  waited_ms: number;
}

const pendingDir = (): string =>
  path.posix.join(DATA_ROOT, 'lex', 'distill-pending');

const markerPath = (brainstormId: string): string =>
  path.posix.join(pendingDir(), `${brainstormId}.json`);

const inFlight = new Map<string, Promise<SessionEndResult>>();

export function readPendingMarker(
  brainstormId: string,
): PendingDistillMarker | null {
  try {
    const raw = fs.readFileSync(markerPath(brainstormId), 'utf-8');
    const parsed = JSON.parse(raw) as PendingDistillMarker;
    if (parsed && typeof parsed.brainstorm_id === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeMarker(marker: PendingDistillMarker): void {
  try {
    ensureDir(pendingDir());
    fs.writeFileSync(
      markerPath(marker.brainstorm_id),
      JSON.stringify(marker, null, 2),
    );
  } catch {
    /* The marker is a durability aid; a failed write must never
     * block the end path itself. The in-flight run still happens. */
  }
}

function clearMarker(brainstormId: string): void {
  try {
    fs.unlinkSync(markerPath(brainstormId));
  } catch {
    /* already gone / never written */
  }
}

/** Test seam. */
export function _resetInFlightForTests(): void {
  inFlight.clear();
}

/**
 * Queue the session-end pipeline WITHOUT blocking the caller.
 * Writes the persisted marker first (so a crash between "queued"
 * and "completed" is recoverable), joins an already-running
 * pipeline for the same brainstorm instead of double-running, and
 * clears the marker only on success. Returns the run's promise so
 * callers that DO want to await (the cold-start gate) can.
 */
export function queueSessionEndPipeline(
  store: Store,
  input: SessionEndInput,
  log: (msg: string) => void = () => undefined,
): Promise<SessionEndResult> {
  const existing = inFlight.get(input.brainstormId);
  if (existing) {
    log(
      `[distill-pending] join: pipeline already in flight brainstorm=${input.brainstormId.slice(0, 8)} reason=${input.reason}`,
    );
    return existing;
  }
  writeMarker({
    brainstorm_id: input.brainstormId,
    claude_session_id: input.claudeSessionId,
    mode: input.mode,
    reason: input.reason,
    queued_ms: Date.now(),
  });
  log(
    `[distill-pending] queued brainstorm=${input.brainstormId.slice(0, 8)} reason=${input.reason}`,
  );
  const run = (async (): Promise<SessionEndResult> => {
    try {
      const result = await runSessionEndPipeline(store, input, log);
      clearMarker(input.brainstormId);
      log(
        `[distill-pending] completed brainstorm=${input.brainstormId.slice(0, 8)} drafts=${result.drafts_created} summary=${result.summary_written}`,
      );
      return result;
    } catch (err) {
      const marker = readPendingMarker(input.brainstormId);
      if (marker) {
        marker.last_error = (err as Error).message;
        marker.last_error_ms = Date.now();
        writeMarker(marker);
      }
      log(
        `[distill-pending] FAILED brainstorm=${input.brainstormId.slice(0, 8)}: ${(err as Error).message}; marker kept for retry on next cold start`,
      );
      throw err;
    } finally {
      inFlight.delete(input.brainstormId);
    }
  })();
  inFlight.set(input.brainstormId, run);
  return run;
}

/**
 * Cold-start gate. If distillation is owed for this brainstorm
 * (in flight, or a marker survived a restart/failure), run/join it
 * and wait BOUNDED (capMs, default DISTILL_AWAIT_CAP_MS) so the new
 * session's preload reads a fresh last_summary. Timeout proceeds
 * loudly rather than hanging session start.
 */
export async function awaitPendingDistill(
  store: Store,
  brainstormId: string,
  log: (msg: string) => void = () => undefined,
  capMs: number = DISTILL_AWAIT_CAP_MS,
): Promise<AwaitPendingResult> {
  let run = inFlight.get(brainstormId);
  if (!run) {
    const marker = readPendingMarker(brainstormId);
    if (!marker) return { outcome: 'none', waited_ms: 0 };
    log(
      `[distill-pending] cold start owes distillation brainstorm=${brainstormId.slice(0, 8)} (queued ${new Date(marker.queued_ms).toISOString()}${marker.last_error ? `, prior failure: ${marker.last_error}` : ''}); forcing run`,
    );
    run = queueSessionEndPipeline(
      store,
      {
        brainstormId: marker.brainstorm_id,
        claudeSessionId: marker.claude_session_id,
        mode: marker.mode,
        reason: `cold-start-forced (was: ${marker.reason})`,
      },
      log,
    );
  } else {
    log(
      `[distill-pending] cold start waiting on in-flight distillation brainstorm=${brainstormId.slice(0, 8)}`,
    );
  }
  const started = Date.now();
  const TIMEOUT = Symbol('timeout');
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const raced = await Promise.race([
      run.then(
        () => 'completed' as const,
        () => 'failed' as const,
      ),
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), capMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
    const waited = Date.now() - started;
    if (raced === TIMEOUT) {
      log(
        `[distill-pending] cold-start wait TIMED OUT after ${waited}ms (cap ${capMs}ms) brainstorm=${brainstormId.slice(0, 8)}; proceeding with possibly-stale preload; run continues in background`,
      );
      return { outcome: 'timeout', waited_ms: waited };
    }
    log(
      `[distill-pending] cold-start wait ${raced} in ${waited}ms brainstorm=${brainstormId.slice(0, 8)}`,
    );
    return { outcome: raced, waited_ms: waited };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
