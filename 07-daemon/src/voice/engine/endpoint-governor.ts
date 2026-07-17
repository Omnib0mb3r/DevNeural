/**
 * Endpoint governor: LiveKit-style bounded dynamic delay around Smart
 * Turn verdicts (VOICE-TOP-LAYER-SPEC.md). Pauses never end the
 * operator's turn; the semantic model decides, inside hard bounds:
 *
 *   - floor  (~0.5s): even a confident "complete" never ships before
 *     this - twitchy sub-half-second endpointing reads as being cut
 *     off mid-word.
 *   - ceiling (~3s): an "incomplete" verdict extends the wait instead
 *     of shipping the fragment, but the hard fallback ships at the
 *     ceiling no matter what so a wrong verdict can never hold the
 *     turn hostage. Alibaba's production numbers corroborate the
 *     shape (200ms check cadence, 3000ms max hold).
 *
 * Pure decision function over (state, verdict, now). The caller owns
 * timers and re-invokes at nextCheckInMs while holding.
 */

export type SmartTurnVerdict = 'complete' | 'incomplete' | 'unavailable';

export interface EndpointState {
  /** When the silence (candidate end-of-turn) began. */
  silenceStartMs: number;
}

export interface EndpointDecision {
  action: 'ship' | 'hold';
  /** Present on hold: when to re-evaluate. Bounded to the check
   * cadence so a held turn is re-examined promptly. */
  nextCheckInMs?: number;
}

export const ENDPOINT_MIN_DELAY_MS = 500;
export const ENDPOINT_MAX_HOLD_MS = 3_000;
export const ENDPOINT_CHECK_INTERVAL_MS = 200;

export function createEndpointState(silenceStartMs: number): EndpointState {
  return { silenceStartMs };
}

export function decideEndpoint(
  state: EndpointState,
  verdict: SmartTurnVerdict,
  nowMs: number,
  opts: {
    minDelayMs?: number;
    maxHoldMs?: number;
    checkIntervalMs?: number;
  } = {},
): EndpointDecision {
  const minDelay = opts.minDelayMs ?? ENDPOINT_MIN_DELAY_MS;
  const maxHold = opts.maxHoldMs ?? ENDPOINT_MAX_HOLD_MS;
  const cadence = opts.checkIntervalMs ?? ENDPOINT_CHECK_INTERVAL_MS;
  const elapsed = nowMs - state.silenceStartMs;

  /* Hard fallback: the ceiling ships regardless of verdict. */
  if (elapsed >= maxHold) return { action: 'ship' };

  /* The floor holds regardless of verdict. */
  if (elapsed < minDelay) {
    return {
      action: 'hold',
      nextCheckInMs: Math.min(cadence, minDelay - elapsed),
    };
  }

  switch (verdict) {
    case 'complete':
    case 'unavailable':
      /* Past the floor with either a confident end or no model at
       * all (degrade to the old fixed-delay behavior). */
      return { action: 'ship' };
    case 'incomplete':
      return {
        action: 'hold',
        nextCheckInMs: Math.min(cadence, maxHold - elapsed),
      };
  }
}
