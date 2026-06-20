/* Heartbeat folded into the single mouth (pillar 3, sliver V6).
 *
 * The haiku layer is always-on, the single mouth, and cheap, so it owns
 * the "still working" heartbeat: it trails BOTH the Lex deep-brain jsonl
 * and the worker jsonl and emits a grounded status pulse through the same
 * mouth as every other utterance. Routing it through the mouth is what
 * makes the heartbeat structurally unable to talk over Lex.
 *
 * This module adds two things on top of the existing locked smart-
 * heartbeat gate (lex-voice-heartbeat.ts), which it REUSES, not
 * replaces:
 *   1. composeHeartbeat - a grounded, persona-correct pulse line. First
 *      person for Lex's own deep-brain work; the worker is the only "he".
 *   2. shouldSpeakHeartbeatHaiku - the gate plus a cross-source mouth
 *      guard: when haiku owns the mouth, never pulse while the mouth is
 *      held by any source. Flag OFF: identical to the existing gate.
 */
import {
  shouldHeartbeat,
  type HeartbeatGate,
} from './lex-voice-heartbeat.js';
import { useVoiceHaiku } from './voice-haiku.js';
import { isMouthHeld } from './voice-mouth.js';

function minutesPhrase(elapsedMs: number): string {
  const m = Math.round(elapsedMs / 60_000);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

export interface HeartbeatComposeInput {
  /** How long Lex's current turn has been running (now - awaitingSince). */
  lexElapsedMs: number;
  /** Worker status when a worker turn is what we're actually waiting on.
   * The worker is the only third-person actor in a heartbeat line. */
  worker?: { elapsedMs: number } | null;
}

/* Grounded pulse text. When a worker is in flight, report the worker (the
 * only "he"); otherwise report Lex's own deep-brain work in the first
 * person - to the user there is one Lex, so no third-person "Lex". */
export function composeHeartbeat(input: HeartbeatComposeInput): string {
  if (input.worker) {
    if (input.worker.elapsedMs < 60_000) return 'The worker just got going.';
    return `The worker's about ${minutesPhrase(input.worker.elapsedMs)} in, still going.`;
  }
  if (input.lexElapsedMs < 60_000) return 'Still on it.';
  return `Still on it, about ${minutesPhrase(input.lexElapsedMs)} in.`;
}

/* The locked gate, plus the single-mouth guard. With haiku ON a pulse
 * must not fire while the mouth is held by ANY source (Lex reply, glue,
 * another connection) - the mouth is the structural anti-double-talk
 * point. With haiku OFF this is exactly shouldHeartbeat (no behavior
 * change). */
export function shouldSpeakHeartbeatHaiku(g: HeartbeatGate): boolean {
  if (!shouldHeartbeat(g)) return false;
  if (useVoiceHaiku() && isMouthHeld()) return false;
  return true;
}
