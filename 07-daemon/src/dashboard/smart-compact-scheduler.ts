/**
 * Smart-compact scheduler tick.
 *
 * Walks every live project_session anchor, runs evaluateSmartCompact,
 * fires the resulting action (fire | wrap) through fireSmartCompact.
 * Pure orchestrator: every side effect (ctx provider, phase resolver,
 * PTY injector, now()) flows through injected deps so tests can drive
 * the loop without spinning the daemon up.
 *
 * Wired into daemon.ts on a configurable interval
 * (DEVNEURAL_SMART_COMPACT_TICK_MS, default 60s). Global toggle gate
 * lives inside fireSmartCompact; the scheduler still evaluates and
 * logs decisions so the audit panel reflects intended fires even
 * when the operator has the kill-switch on.
 */
import type { IndexDb } from '../store/index-db.js';
import {
  evaluateSmartCompact,
  fireSmartCompact,
  type EvaluateOptions,
  type EvaluateResult,
  type PtyInjector,
} from './smart-compact-routes.js';

export interface SchedulerDeps {
  db: IndexDb;
  injector: PtyInjector;
  /** Resolve ctx_pct for an anchor's open transcript. Tests inject
   * a deterministic stub; production binds via the existing
   * deriveContextFromTail path. */
  ctxProvider?: (jsonlPath: string) => number | null;
  /** Override the evaluate call. Tests use this to assert the
   * scheduler-built EvaluateOptions shape. */
  evaluator?: typeof evaluateSmartCompact;
  log?: (msg: string) => void;
}

export interface TickResult {
  evaluated: number;
  fired: string[];
  wrapped: string[];
  waited: string[];
  errors: string[];
}

export async function runSmartCompactTick(
  deps: SchedulerDeps,
): Promise<TickResult> {
  const log = deps.log ?? (() => undefined);
  const evaluate = deps.evaluator ?? evaluateSmartCompact;
  const result: TickResult = {
    evaluated: 0,
    fired: [],
    wrapped: [],
    waited: [],
    errors: [],
  };
  const live = deps.db.listProjectSessions({ status: 'live', limit: 1000 });
  for (const row of live) {
    result.evaluated += 1;
    try {
      const opts: EvaluateOptions = {};
      if (deps.ctxProvider) opts.ctxProvider = deps.ctxProvider;
      const v: EvaluateResult = evaluate(deps.db, row.id, opts);
      if (!v.ok) continue;
      if (v.action === 'wait') {
        result.waited.push(row.id);
        continue;
      }
      const r = fireSmartCompact(deps.db, row.id, {
        caller: 'scheduler',
        reason: v.reason,
        action: v.action,
        ctxPct: v.ctx_pct,
        ...(v.summary !== undefined ? { summary: v.summary } : {}),
        injector: deps.injector,
      });
      if (v.action === 'fire') result.fired.push(row.id);
      else result.wrapped.push(row.id);
      log(
        `[smart-compact-tick] anchor=${row.id.slice(0, 8)} action=${r.action} reason=${v.reason} ctx=${v.ctx_pct ?? 'n/a'}`,
      );
    } catch (err) {
      result.errors.push(row.id);
      log(
        `[smart-compact-tick] anchor=${row.id.slice(0, 8)} failed: ${(err as Error).message}`,
      );
    }
  }
  return result;
}
