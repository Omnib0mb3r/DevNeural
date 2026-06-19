/**
 * Pure helpers for the "still working" voice heartbeat.
 *
 * While a Lex turn is in flight (awaitingResponseSince > 0, which spans
 * the whole turn including long silent tool calls) the daemon MAY emit a
 * rare, honest pulse so the user is not left wondering on a genuinely
 * long wait. Redesigned 2026-06-18 from a chatty 12s timer into a smart,
 * half-duplex-safe signal:
 *
 *   - Fires only when Lex is actually processing a long op the user is
 *     waiting on; never when idle / just listening (awaitingSince === 0).
 *   - NEVER while the user is speaking, and not within a short cooldown
 *     after they stop. Lex speaking mutes the mic, so a pulse over the
 *     user makes Lex deaf to what the user just said. This is the hard
 *     gate; everything else is secondary to it.
 *   - Only after a long stretch of continuous silence (~2 min), then
 *     rarely. Not a stuck "on it, on it" loop.
 *   - Carries honest, specific content (how long it has been working),
 *     not rotating canned filler.
 *
 * The pulse still carries ZERO answer substance; the real answer is
 * spoken once at end_turn. The decision logic lives here, pure, so it
 * can be unit-tested without the WS, the speak controller, or timers.
 */

/** Silence threshold before a pulse fires (epoch-ms delta). ~2 minutes:
 * the user asked for reassurance only on a genuinely long wait, never
 * the few-second pause a normal reply takes. */
export const HEARTBEAT_INTERVAL_MS = 120_000;
/** How often the in-flight watcher re-evaluates the gate. */
export const HEARTBEAT_TICK_MS = 4_000;
/** Grace after the user stops speaking before a pulse may fire, so Lex
 * never talks on the heels of the user's last word. */
export const HEARTBEAT_SPEECH_COOLDOWN_MS = 4_000;

/** Honest, duration-aware pulse text. Reports how long the current turn
 * has been running instead of a canned phrase, so a repeated pulse
 * carries real information rather than sounding like a stuck loop.
 * elapsedMs is now - awaitingResponseSince at fire time. */
export function heartbeatPhrase(elapsedMs: number): string {
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 1) return 'Still on it.';
  return `Still working on this, about ${minutes} minute${minutes === 1 ? '' : 's'} in.`;
}

export interface HeartbeatGate {
  /** awaitingResponseSince: 0 when no turn is in flight. */
  awaitingSince: number;
  /** Epoch ms of the last TTS activity (0 if none yet this connection). */
  lastSpeechMs: number;
  /** A TTS stream is playing right now. */
  ttsActive: boolean;
  /** True while the user is mid-utterance (between utterance-start and
   * utterance-end). A pulse must never fire here. */
  userSpeaking: boolean;
  /** Epoch ms the user last stopped speaking (0 if never). Used with
   * cooldownMs to keep a pulse off the heels of the user's last word. */
  lastUserSpeechEndMs: number;
  /** Connection mode; 'notes' suppresses the heartbeat entirely. */
  mode: string;
  now: number;
  /** Silence threshold; normally HEARTBEAT_INTERVAL_MS. */
  intervalMs: number;
  /** Grace after the user stops speaking; defaults to
   * HEARTBEAT_SPEECH_COOLDOWN_MS when omitted. */
  cooldownMs?: number;
}

/** True when an honest "still working" pulse should fire now. Fires only
 * while a turn is in flight, never while audio is already playing, never
 * while (or just after) the user is speaking, never in notes mode, and
 * only after intervalMs of continuous silence. */
export function shouldHeartbeat(g: HeartbeatGate): boolean {
  if (g.mode === 'notes') return false;
  if (!g.awaitingSince) return false;
  if (g.ttsActive) return false;
  if (g.userSpeaking) return false;
  const cooldown = g.cooldownMs ?? HEARTBEAT_SPEECH_COOLDOWN_MS;
  if (g.lastUserSpeechEndMs && g.now - g.lastUserSpeechEndMs < cooldown) {
    return false;
  }
  const silentSince = Math.max(g.awaitingSince, g.lastSpeechMs);
  return g.now - silentSince >= g.intervalMs;
}
