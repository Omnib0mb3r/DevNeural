/**
 * Smart-compact scheduler tick.
 *
 * v2 - Lex-authored resume prompts. The daemon no longer builds the
 * resume summary, so a scheduler-driven action='fire' would have no
 * author and would inject a blank line after /clear. The scheduler
 * now downgrades action='fire' to a logged 'wait' and only the
 * action='wrap' path performs an inject (using the daemon-authored
 * WRAP_AND_COMMIT_PROMPT). Live fires are Lex-only: Lex composes the
 * resume prompt from its own conversation context and posts it to
 * /lex/smart-compact/fire with an explicit summary.
 *
 * Walks every live project_session anchor, runs evaluateSmartCompact,
 * routes action='wrap' through fireSmartCompact, defers action='fire'
 * to Lex. Pure orchestrator: every side effect (ctx provider, phase
 * resolver, PTY injector, now()) flows through injected deps so tests
 * can drive the loop without spinning the daemon up.
 *
 * Wired into daemon.ts on a configurable interval
 * (DEVNEURAL_SMART_COMPACT_TICK_MS, default 60s). Global toggle gate
 * lives inside fireSmartCompact; the scheduler still evaluates and
 * logs decisions so the audit panel reflects intended fires even
 * when the operator has the kill-switch on.
 */
import * as os from 'node:os';
import type { IndexDb } from '../store/index-db.js';
import {
  evaluateSmartCompact,
  fireSmartCompact,
  smartCompactPolicyOwner,
  type EvaluateOptions,
  type EvaluateResult,
  type PtyInjector,
  type SmartCompactPolicyOwner,
} from './smart-compact-routes.js';
import {
  awaitNewSessionReady,
  capturePreClearJsonlSet,
  ccProjectsDirForCwd,
  type SessionReadyResult,
} from './smart-compact-injector.js';

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
  /** Override the policy-owner read. Tests use this to drive the
   * short-circuit branch without touching runtime_config; production
   * resolves through smartCompactPolicyOwner(db). */
  policyOwnerProvider?: (db: IndexDb) => SmartCompactPolicyOwner;
  log?: (msg: string) => void;
}

export interface TickResult {
  evaluated: number;
  fired: string[];
  wrapped: string[];
  waited: string[];
  /** Anchors where the evaluator returned action='fire' but the
   * scheduler deferred to Lex (v2 - daemon no longer authors the
   * resume prompt). */
  deferredFire: string[];
  errors: string[];
  /** Fix 41 Stage 2: anchors where the scheduler observed a verdict
   * but skipped all firing because the policy owner is 'lex'. The
   * scheduler logs the evaluation for visibility and moves on; Lex's
   * own loop is responsible for the inject. */
  shortCircuited: string[];
}

export async function runSmartCompactTick(
  deps: SchedulerDeps,
): Promise<TickResult> {
  const log = deps.log ?? (() => undefined);
  const evaluate = deps.evaluator ?? evaluateSmartCompact;
  const ownerProvider = deps.policyOwnerProvider ?? smartCompactPolicyOwner;
  const policyOwner = ownerProvider(deps.db);
  const result: TickResult = {
    evaluated: 0,
    fired: [],
    wrapped: [],
    waited: [],
    deferredFire: [],
    errors: [],
    shortCircuited: [],
  };
  const live = deps.db.listProjectSessions({ status: 'live', limit: 1000 });
  for (const row of live) {
    result.evaluated += 1;
    try {
      const opts: EvaluateOptions = {};
      if (deps.ctxProvider) opts.ctxProvider = deps.ctxProvider;
      const v: EvaluateResult = await evaluate(deps.db, row.id, opts);
      if (!v.ok) continue;
      if (v.action === 'wait') {
        result.waited.push(row.id);
        continue;
      }
      /* Fix 41 Stage 2 - when the policy owner is 'lex', the scheduler
       * walks every live anchor and runs evaluate so the audit surface
       * still records what the daemon's evaluator would have said, but
       * skips every inject. Lex owns the entire fire/wrap loop via its
       * own polling of /lex/smart-compact/state. The short-circuit
       * fires AFTER the wait check so a clean below-window verdict
       * still counts as "waited" on the daemon side; only an active
       * fire/wrap verdict is the one Lex would have driven. */
      if (policyOwner === 'lex') {
        result.shortCircuited.push(row.id);
        log(
          `[smart-compact-tick] anchor=${row.id.slice(0, 8)} short-circuit policy_owner=lex action=${v.action} reason=${v.reason} ctx=${v.ctx_pct ?? 'n/a'}`,
        );
        continue;
      }
      if (v.action === 'fire') {
        /* v2 - scheduler defers fire to Lex. The daemon no longer
         * authors the resume prompt and a blank inject after /clear
         * would wipe context with nothing to replace it. Log + skip.
         * Lex polls evaluate from its own loop and composes the
         * summary in-context before posting fire. */
        result.deferredFire.push(row.id);
        log(
          `[smart-compact-tick] anchor=${row.id.slice(0, 8)} fire-deferred-to-lex reason=${v.reason} ctx=${v.ctx_pct ?? 'n/a'}`,
        );
        continue;
      }
      /* action='wrap' - daemon-authored WRAP_AND_COMMIT_PROMPT, no
       * summary needed. readiness gate is only meaningful for fire's
       * /clear+summary sequence, so wrap can skip it. */
      let awaitSessionReady:
        | (() => Promise<SessionReadyResult>)
        | undefined;
      if (row.cwd) {
        const ccProjectsDir = ccProjectsDirForCwd(os.homedir(), row.cwd);
        const preClearFiles = capturePreClearJsonlSet(ccProjectsDir);
        awaitSessionReady = () =>
          awaitNewSessionReady({
            ccProjectsDir,
            preClearFiles,
            io: { log },
          });
      }
      const r = fireSmartCompact(deps.db, row.id, {
        caller: 'scheduler',
        reason: v.reason,
        action: v.action,
        ctxPct: v.ctx_pct,
        injector: deps.injector,
        ...(awaitSessionReady ? { awaitSessionReady } : {}),
      });
      result.wrapped.push(row.id);
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
