/* Haiku front desk (pillar 3, sliver V7 capstone composition).
 *
 * The single decision the WS layer calls per inbound utterance when the
 * haiku tier owns the front desk. Composes the whole pillar:
 *
 *   control channel (V2)  -> stop/quiet/abort/redirect, never queued
 *   deny-by-default (V3)  -> glue handled alone, facts queue to Lex
 *   two lanes (V4)        -> fast (haiku alone) vs slow (bridge + Lex)
 *   digest freshness (V7) -> a stale digest forces queue (Hole 2)
 *   persona (V7)          -> the prompt haiku speaks AS Lex from
 *
 * Pure composition. The renderer (V5) and heartbeat (V6) attach at the
 * speak step; the live WS wiring + the actual haiku model calls are the
 * flag-flip capstone. With DEVNEURAL_VOICE_HAIKU OFF nothing calls this,
 * so the current voice path is untouched.
 */
import { routeTurn, type LaneDecision } from './voice-lane-router.js';
import { getDigest, isDigestFresh } from './voice-digest.js';
import { buildHaikuPersonaPrompt } from './voice-persona.js';

export interface FrontDeskDecision {
  /** Lane + control/bridge details. */
  route: LaneDecision;
  /** Persona system prompt grounded in the current live digest. */
  personaPrompt: string;
  /** Whether Lex's digest is fresh as of the last turn boundary. */
  digestFresh: boolean;
}

export function frontDeskDecision(
  text: string,
  ctx: { lastTurnMs: number },
): FrontDeskDecision {
  const digestFresh = isDigestFresh(ctx.lastTurnMs);
  const route = routeTurn(text, { digestFresh });
  const d = getDigest();
  return {
    route,
    personaPrompt: buildHaikuPersonaPrompt(d?.digest ?? null),
    digestFresh,
  };
}
