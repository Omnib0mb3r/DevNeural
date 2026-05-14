/**
 * End-of-turn compaction supervisor.
 *
 * Called by the Lex jsonl watcher after every assistant end_turn
 * record. Reads the latest message.usage to compute the consumed
 * context tokens, asks shouldTriggerCompaction whether the 75%
 * threshold has been crossed, and on a positive result runs the
 * synchronous session-end pipeline followed by a fresh spawn so the
 * brainstorm UI sees one continuous conversation. The detector is
 * intentionally only consulted at end-of-turn so a restart never
 * cuts mid-sentence.
 *
 * Pure orchestration: every side effect is injected so tests pin
 * the trigger contract + the idempotency guard without standing up
 * the real session-end + spawn paths.
 */
import {
  DEFAULT_COMPACTION_RATIO,
  shouldTriggerCompaction,
} from './compaction-trigger.js';

const DEFAULT_MODEL_MAX_TOKENS = (() => {
  const raw = process.env.DEVNEURAL_CONTEXT_MAX;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000_000;
})();

export interface UsageLike {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function contextTokensFromUsage(u: UsageLike | undefined | null): number {
  if (!u) return 0;
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0)
  );
}

export interface CompactionSupervisorState {
  /** Date.now() of the most recent successful compaction fire on
   * this Lex session; 0 when this session has not compacted. The
   * supervisor flips this the moment the restart contract starts so
   * a trailing end_turn record in the same jsonl tail does not
   * re-fire. */
  compactedAt: number;
}

export interface CompactionSupervisorDeps {
  /** Synchronous session-end pipeline (distill, summary, embed).
   * Wired to fireSessionEndPipeline('compaction-restart') in voice-
   * ws. Must resolve before the spawn fires so the just-ended
   * session's last_summary lands BEFORE the new session's cold-start
   * preload reads it. */
  runSessionEnd: () => Promise<void>;
  /** Boot a fresh Lex session against the same anchor. Wired to
   * spawnLexSession({ lexSessionId: handle.brainstormId, ... }) in
   * voice-ws so the existing reopen path produces a new CC session
   * id under the same brainstorm anchor, which is what the spec asks
   * for ("new session id is fine, UI continuity is what matters"). */
  spawnRestart: () => Promise<{ ok: boolean; new_session_id?: string | null; error?: string }>;
  /** Audit logger. Defaults to a no-op so unit tests don't need a
   * sink. */
  log?: (msg: string) => void;
  /** Override the model max context. Defaults to env DEVNEURAL_
   * CONTEXT_MAX or 1_000_000. */
  modelMaxTokens?: number;
  /** Override the trigger ratio. Defaults to 0.75. */
  ratio?: number;
  /** Mutable state for idempotency. The supervisor flips compactedAt
   * the moment a restart begins so a trailing end_turn record in the
   * jsonl tail does not re-trigger. */
  state: CompactionSupervisorState;
}

export type CompactionOutcomeReason =
  | 'fired'
  | 'under-threshold'
  | 'already-compacted'
  | 'invalid-input'
  | 'restart-failed';

export interface CompactionOutcome {
  fired: boolean;
  reason: CompactionOutcomeReason;
  observedRatio: number;
  contextTokens: number;
  modelMaxTokens: number;
  /** Populated when fired=true. The fresh session id returned by
   * spawnRestart, or null when the spawn failed but the session-end
   * pipeline already ran. */
  new_session_id?: string | null;
  /** Populated when reason='restart-failed'. */
  error?: string;
}

export async function maybeCompactOnTurnEnd(
  signal: { contextTokens: number },
  deps: CompactionSupervisorDeps,
): Promise<CompactionOutcome> {
  const log = deps.log ?? (() => undefined);
  const modelMax = deps.modelMaxTokens ?? DEFAULT_MODEL_MAX_TOKENS;
  const ratio = deps.ratio ?? DEFAULT_COMPACTION_RATIO;
  const tokens = Math.max(0, Math.floor(signal.contextTokens || 0));
  if (deps.state.compactedAt > 0) {
    return {
      fired: false,
      reason: 'already-compacted',
      observedRatio: tokens / modelMax,
      contextTokens: tokens,
      modelMaxTokens: modelMax,
    };
  }
  const gate = shouldTriggerCompaction({
    contextTokens: tokens,
    modelMaxTokens: modelMax,
    ratio,
  });
  if (gate.reason === 'invalid-input') {
    return {
      fired: false,
      reason: 'invalid-input',
      observedRatio: gate.observedRatio,
      contextTokens: tokens,
      modelMaxTokens: modelMax,
    };
  }
  if (!gate.compactionDue) {
    return {
      fired: false,
      reason: 'under-threshold',
      observedRatio: gate.observedRatio,
      contextTokens: tokens,
      modelMaxTokens: modelMax,
    };
  }
  /* Flip the idempotency flag BEFORE the awaited work so a trailing
   * end_turn record in the jsonl tail that arrives while we are
   * still distilling does not re-enter the supervisor. */
  deps.state.compactedAt = Date.now();
  log(
    `[lex-compaction] threshold crossed ctx=${tokens}/${modelMax} ratio=${gate.observedRatio.toFixed(3)} >= ${ratio}; running session-end + spawn-restart`,
  );
  try {
    await deps.runSessionEnd();
  } catch (err) {
    log(
      `[lex-compaction] session-end pipeline threw, continuing to spawn-restart: ${(err as Error).message}`,
    );
  }
  let spawnResult: { ok: boolean; new_session_id?: string | null; error?: string };
  try {
    spawnResult = await deps.spawnRestart();
  } catch (err) {
    spawnResult = { ok: false, error: (err as Error).message };
  }
  if (!spawnResult.ok) {
    log(
      `[lex-compaction] spawn-restart failed: ${spawnResult.error ?? 'unknown'}`,
    );
    return {
      fired: true,
      reason: 'restart-failed',
      observedRatio: gate.observedRatio,
      contextTokens: tokens,
      modelMaxTokens: modelMax,
      error: spawnResult.error ?? 'unknown',
    };
  }
  log(
    `[lex-compaction] restart ok; new_session_id=${spawnResult.new_session_id ?? 'unknown'}`,
  );
  return {
    fired: true,
    reason: 'fired',
    observedRatio: gate.observedRatio,
    contextTokens: tokens,
    modelMaxTokens: modelMax,
    new_session_id: spawnResult.new_session_id ?? null,
  };
}
