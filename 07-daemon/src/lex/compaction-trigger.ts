/**
 * Mid-session compaction trigger for Lex.
 *
 * Pure token-threshold detector. The supervisor calls this every
 * turn boundary to decide whether the current Lex session should
 * end and a fresh one boot via the existing cold-start preload
 * pipeline. The trigger is intentionally only consulted at
 * end-of-turn so nothing gets cut mid-sentence.
 *
 * Strict cold-restart contract (the actual restart execution lives
 * in the supervisor that calls this detector):
 *   1. detector reports compactionDue=true once context >= 75% of
 *      the model's max.
 *   2. supervisor finishes the current turn, runs the synchronous
 *      session-end pipeline (distill + persist), then boots a fresh
 *      Lex session.
 *   3. fresh session boots via the cold-start preload route, which
 *      force-distills the just-ended sibling synchronously before
 *      assembling the sibling index (see lex-cold-start-preamble for
 *      the race-free contract).
 *   4. UI continuity is preserved by emitting a single transcript
 *      stream the dashboard renders; new session id is allowed.
 *
 * Pure module: zero side effects, every input is a plain value so
 * tests can exhaustively cover the threshold edges.
 */

export const DEFAULT_COMPACTION_RATIO = 0.75;

export interface CompactionTriggerInput {
  /** Tokens currently in the Lex session's context window. */
  contextTokens: number;
  /** Model's max-context cap (e.g. 200_000 for sonnet-4.6). */
  modelMaxTokens: number;
  /** Threshold ratio. Defaults to 0.75 (75%). */
  ratio?: number;
}

export interface CompactionTriggerResult {
  /** True when context_tokens / model_max_tokens >= ratio. */
  compactionDue: boolean;
  /** Computed ratio at the time of the call, clamped to [0, 1]. */
  observedRatio: number;
  /** Threshold ratio that was applied. */
  thresholdRatio: number;
  /** Reason tag for the audit log. */
  reason: 'over-threshold' | 'under-threshold' | 'invalid-input';
}

export function shouldTriggerCompaction(
  input: CompactionTriggerInput,
): CompactionTriggerResult {
  const ratio = input.ratio ?? DEFAULT_COMPACTION_RATIO;
  if (
    !Number.isFinite(input.contextTokens) ||
    !Number.isFinite(input.modelMaxTokens) ||
    input.modelMaxTokens <= 0 ||
    input.contextTokens < 0 ||
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    ratio > 1
  ) {
    return {
      compactionDue: false,
      observedRatio: 0,
      thresholdRatio: ratio,
      reason: 'invalid-input',
    };
  }
  const observed = Math.min(1, input.contextTokens / input.modelMaxTokens);
  if (observed >= ratio) {
    return {
      compactionDue: true,
      observedRatio: observed,
      thresholdRatio: ratio,
      reason: 'over-threshold',
    };
  }
  return {
    compactionDue: false,
    observedRatio: observed,
    thresholdRatio: ratio,
    reason: 'under-threshold',
  };
}
