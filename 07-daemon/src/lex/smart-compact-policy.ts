/**
 * Smart-compact policy module (Fix 41 Stage 2).
 *
 * Owns the decisioning surface: `evaluateTrigger` + the Lex-facing
 * `evaluateTriggerForAnchor` wrapper + the `WRAP_AND_COMMIT_PROMPT`
 * default. These were previously in `lex/smart-compact.ts` next to
 * mechanical helpers (jsonl tail derivation, shadow-count read);
 * Stage 2 separates the policy half so Lex can consume it as a pure
 * library without dragging the daemon's IndexDb-bound helpers along.
 *
 * `lex/smart-compact.ts` keeps re-exports for back-compat through the
 * cutover; Stage 3 deletes the legacy module entirely.
 *
 * The new entry point is `evaluateTriggerForAnchor(state, defaults,
 * opts)` which takes the same shape the new
 * `GET /lex/smart-compact/state` endpoint returns. Lex polls /state,
 * passes the result here, gets back a verdict + stop-point reason,
 * then either calls /clear-and-paste, /wrap-paste, or waits.
 *
 * Backwards-compat: the original `evaluateTrigger(input)` is kept as
 * an exported alias so the daemon's compat-shim `/evaluate` route
 * keeps working through Stages 2 and 3.
 */
import type { Phase, EvalAction, EvalReason } from './smart-compact-types.js';

export type { Phase, EvalAction, EvalReason } from './smart-compact-types.js';

export interface EvalInput {
  ctxPct: number;
  threshold: number;
  bandHalf: number;
  hardCeiling: number;
  stopWindowMs: number;
  now: number;
  lastCommitMs: number | null;
  lastToolMs: number | null;
  phase: Phase;
}

export interface EvalResult {
  action: EvalAction;
  reason: EvalReason;
}

const STOP_PHASES: ReadonlySet<Phase> = new Set(['idle', 'permission']);

export function evaluateTrigger(input: EvalInput): EvalResult {
  const {
    ctxPct,
    threshold,
    bandHalf,
    hardCeiling,
    stopWindowMs,
    now,
    lastCommitMs,
    lastToolMs,
    phase,
  } = input;

  if (ctxPct >= hardCeiling) {
    return { action: 'fire', reason: 'hard-ceiling' };
  }

  const lo = threshold - bandHalf;
  const hi = threshold + bandHalf;

  if (ctxPct < lo) {
    return { action: 'wait', reason: 'below-window' };
  }

  const recentCommit =
    lastCommitMs !== null && now - lastCommitMs <= stopWindowMs;
  const idleTool = lastToolMs === null || now - lastToolMs > stopWindowMs;
  const stopPhase = STOP_PHASES.has(phase);
  const hasStop = recentCommit || idleTool || stopPhase;

  if (ctxPct <= hi) {
    if (hasStop) return { action: 'fire', reason: 'window-open' };
    return { action: 'wait', reason: 'no-stop' };
  }

  return { action: 'wrap', reason: 'forced-no-stop' };
}

export const WRAP_AND_COMMIT_PROMPT =
  'Wrap your current work: commit what is stable with a meaningful message, defer the rest with a TODO comment if needed. Reply "ready" when done. Reason: context refresh in progress.';

/* ---------------------------------------------------------------- *
 *  Lex-facing wrapper: evaluateTriggerForAnchor                      *
 * ---------------------------------------------------------------- *
 *
 * Takes the same shape the new GET /lex/smart-compact/state endpoint
 * returns and produces a verdict + a stop-point classification so the
 * dashboard / audit log can show why the verdict landed where it did.
 *
 * `stop_point` semantics:
 *   recent_commit   lastCommitMs is within stopWindowMs of now.
 *   idle_tool       lastToolMs is null or older than stopWindowMs.
 *   idle_phase      phase ∈ {idle, permission}.
 *   none            ctx is inside the window but no stop signal fired.
 *   n/a             ctx outside the window (below-window or
 *                   hard-ceiling), so stop point is irrelevant.
 *
 * Multiple stop signals can be true at once; the function returns the
 * first one in priority order recent_commit > idle_tool > idle_phase.
 * This matches the operator's "real stop" precedence: a fresh commit
 * is the strongest signal that the worker is at a clean boundary.
 */

export interface PolicyState {
  ctx_pct: number | null;
  last_commit_ms: number | null;
  last_tool_ms: number | null;
}

export interface PolicyDefaults {
  threshold: number;
  bandHalf: number;
  hardCeiling: number;
  stopWindowMs: number;
}

export interface PolicyOptions {
  phase?: Phase;
  now?: number;
}

export type StopPoint =
  | 'recent_commit'
  | 'idle_tool'
  | 'idle_phase'
  | 'none'
  | 'n/a';

export interface PolicyResult {
  action: EvalAction;
  reason: EvalReason;
  stop_point: StopPoint;
}

export function evaluateTriggerForAnchor(
  state: PolicyState,
  defaults: PolicyDefaults,
  opts: PolicyOptions = {},
): PolicyResult {
  /* Null ctx_pct means we haven't observed enough of the jsonl tail
   * to derive a percent. Match the legacy evaluateSmartCompact route's
   * behaviour: stay at wait/below-window so Lex polls again on its
   * next tick. */
  if (state.ctx_pct === null) {
    return { action: 'wait', reason: 'below-window', stop_point: 'n/a' };
  }
  const now = opts.now ?? Date.now();
  const phase = opts.phase ?? 'unknown';
  const verdict = evaluateTrigger({
    ctxPct: state.ctx_pct,
    threshold: defaults.threshold,
    bandHalf: defaults.bandHalf,
    hardCeiling: defaults.hardCeiling,
    stopWindowMs: defaults.stopWindowMs,
    now,
    lastCommitMs: state.last_commit_ms,
    lastToolMs: state.last_tool_ms,
    phase,
  });
  const stop_point = classifyStopPoint(
    state.ctx_pct,
    state.last_commit_ms,
    state.last_tool_ms,
    phase,
    defaults,
    now,
  );
  return { ...verdict, stop_point };
}

function classifyStopPoint(
  ctxPct: number,
  lastCommitMs: number | null,
  lastToolMs: number | null,
  phase: Phase,
  defaults: PolicyDefaults,
  now: number,
): StopPoint {
  const lo = defaults.threshold - defaults.bandHalf;
  const hi = defaults.threshold + defaults.bandHalf;
  /* Outside the band the stop point is not what drove the decision. */
  if (ctxPct < lo || ctxPct > hi) return 'n/a';
  if (lastCommitMs !== null && now - lastCommitMs <= defaults.stopWindowMs) {
    return 'recent_commit';
  }
  if (lastToolMs === null || now - lastToolMs > defaults.stopWindowMs) {
    return 'idle_tool';
  }
  if (phase === 'idle' || phase === 'permission') return 'idle_phase';
  return 'none';
}

export interface PolicyDefaultsConfig {
  threshold?: number;
  bandHalf?: number;
  hardCeiling?: number;
  stopWindowMs?: number;
}

/* Sensible defaults Lex can use when no operator override is in
 * memory. Mirrors the original `defaults()` env-driven values; Stage
 * 3 will move env lookups out and Lex owns the source of truth. */
export function policyDefaults(
  override: PolicyDefaultsConfig = {},
): PolicyDefaults {
  return {
    threshold: override.threshold ?? 60,
    bandHalf: override.bandHalf ?? 5,
    hardCeiling: override.hardCeiling ?? 90,
    stopWindowMs: override.stopWindowMs ?? 30_000,
  };
}
