/**
 * Worker event diagnostics writer.
 *
 * Stage-by-stage instrumentation for the event-driven Lex supervisor.
 * Fix 34: the wire was silently dropping every event; without per-
 * stage rows the dead branch was not locatable. Each call appends to
 * worker_event_diagnostic_log + bumps an in-process counter so a
 * dashboard probe can answer "is the wire alive?" without a DB scan.
 *
 * After the fix lands, the verbose stages (chokidar.* / detector.* /
 * gate.*) stay off in production; the resolver / inject stages stay
 * on by default so a future regression surfaces in /health.supervisor.
 * Verbose mode = env DEVNEURAL_SUPERVISOR_DEBUG=1.
 */
import { randomUUID } from 'node:crypto';
import type { IndexDb } from '../store/index-db.js';

export type WorkerEventStage =
  | 'chokidar.bound'
  | 'chokidar.line'
  | 'detector.matched'
  | 'gate.evaluated'
  | 'route.resolved'
  | 'inject.attempted'
  | 'inject.result';

/* Stages that stay on in production without DEVNEURAL_SUPERVISOR_DEBUG.
 * These three are the smallest signal that proves the wire delivers
 * end-to-end (target resolution + inject call + inject outcome). */
const ALWAYS_ON_STAGES: ReadonlySet<WorkerEventStage> = new Set([
  'route.resolved',
  'inject.attempted',
  'inject.result',
]);

function debugEnabled(): boolean {
  const v = process.env.DEVNEURAL_SUPERVISOR_DEBUG;
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true';
}

interface CountersState {
  bootMs: number;
  perStage: Map<WorkerEventStage, number>;
}

let counters: CountersState = {
  bootMs: Date.now(),
  perStage: new Map(),
};

export function _resetWorkerEventDiagnosticCounters(): void {
  counters = { bootMs: Date.now(), perStage: new Map() };
}

export interface RecordOptions {
  db: IndexDb;
  stage: WorkerEventStage;
  anchorId?: string | null;
  verdict?: string | null;
  detail?: string | null;
}

export function recordWorkerEventDiagnostic(opts: RecordOptions): void {
  /* Counter bump is always-on regardless of debug. Stats endpoint
   * reads counters even when row writes are suppressed so the
   * dashboard "is the wire alive?" probe stays cheap. */
  counters.perStage.set(
    opts.stage,
    (counters.perStage.get(opts.stage) ?? 0) + 1,
  );
  if (!ALWAYS_ON_STAGES.has(opts.stage) && !debugEnabled()) {
    return;
  }
  try {
    opts.db.insertWorkerEventDiagnostic({
      id: randomUUID(),
      anchor_id: opts.anchorId ?? null,
      stage: opts.stage,
      verdict: opts.verdict ?? null,
      detail: opts.detail ?? null,
    });
  } catch {
    /* writes are best-effort; the counter is the durable signal */
  }
}

export interface WorkerEventStats {
  boot_ms: number;
  uptime_ms: number;
  counters: Record<string, number>;
  recent: Array<{
    id: string;
    ts: string;
    anchor_id: string | null;
    stage: string;
    verdict: string | null;
    detail: string | null;
  }>;
  /* Coarse "is the wire alive?" verdict for /health.supervisor.
   *   - 'no-binds':       chokidar never reported a bound watch
   *   - 'no-events':      bound but no jsonl line ever processed
   *   - 'no-route':       lines processed but resolver never returned
   *                       a target (most common dead-branch)
   *   - 'no-inject':      target resolved but inject was never called
   *   - 'inject-failed':  inject called but always returned !ok
   *   - 'ok':             at least one inject.result with verdict='ok'
   */
  health:
    | 'no-binds'
    | 'no-events'
    | 'no-route'
    | 'no-inject'
    | 'inject-failed'
    | 'ok';
}

export function getWorkerEventStats(db: IndexDb): WorkerEventStats {
  const recordCounters: Record<string, number> = {};
  for (const [k, v] of counters.perStage) recordCounters[k] = v;
  const recent = db.listWorkerEventDiagnostic({ limit: 20 });
  return {
    boot_ms: counters.bootMs,
    uptime_ms: Date.now() - counters.bootMs,
    counters: recordCounters,
    recent,
    health: deriveHealth(counters.perStage, recent),
  };
}

function deriveHealth(
  perStage: Map<WorkerEventStage, number>,
  recent: WorkerEventStats['recent'],
): WorkerEventStats['health'] {
  const binds = perStage.get('chokidar.bound') ?? 0;
  const lines = perStage.get('chokidar.line') ?? 0;
  const routes = perStage.get('route.resolved') ?? 0;
  const attempts = perStage.get('inject.attempted') ?? 0;
  const results = perStage.get('inject.result') ?? 0;
  const okResults = recent.filter(
    (r) => r.stage === 'inject.result' && r.verdict === 'ok',
  ).length;
  if (binds === 0) return 'no-binds';
  if (lines === 0) return 'no-events';
  if (routes === 0) return 'no-route';
  if (attempts === 0) return 'no-inject';
  if (results > 0 && okResults === 0) return 'inject-failed';
  if (okResults > 0) return 'ok';
  return 'no-inject';
}
