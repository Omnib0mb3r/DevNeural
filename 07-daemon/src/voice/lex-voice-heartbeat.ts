/**
 * Pure helpers for the "still working" voice heartbeat.
 *
 * While a Lex turn is in flight (awaitingResponseSince > 0, which spans
 * the whole turn including long silent tool calls) the daemon emits a
 * periodic, content-free pulse so the user is not sitting in silence
 * wondering if anything is happening. Without it he goes to the terminal
 * mirror to check, which he hates.
 *
 * The pulse carries ZERO answer substance; the real answer is spoken
 * once at end_turn. This is ADDITIVE to the pre-tool ack clamp, not a
 * replacement: the clamp stops the ack from carrying the answer (the
 * double-talk), the heartbeat fills silence during long work.
 *
 * The decision logic lives here, pure, so it can be unit-tested without
 * the WS, the speak controller, or any real timers.
 */

/** Silence threshold before a pulse fires (epoch-ms delta). */
export const HEARTBEAT_INTERVAL_MS = 12_000;
/** How often the in-flight watcher re-evaluates the gate. */
export const HEARTBEAT_TICK_MS = 4_000;

const HEARTBEAT_PHRASES = [
  'Still on it.',
  'Still working.',
  'Hang tight.',
  'Almost there.',
];

/** Rotating short phrase so repeated pulses do not sound like a stuck
 * loop. Index is taken modulo the phrase count; negative input is
 * normalised so a misbehaving counter cannot throw. */
export function heartbeatPhrase(n: number): string {
  const len = HEARTBEAT_PHRASES.length;
  const i = ((n % len) + len) % len;
  return HEARTBEAT_PHRASES[i] ?? 'Still on it.';
}

export interface HeartbeatGate {
  /** awaitingResponseSince: 0 when no turn is in flight. */
  awaitingSince: number;
  /** Epoch ms of the last TTS activity (0 if none yet this connection). */
  lastSpeechMs: number;
  /** A TTS stream is playing right now. */
  ttsActive: boolean;
  /** Connection mode; 'notes' suppresses the heartbeat entirely. */
  mode: string;
  now: number;
  /** Silence threshold; normally HEARTBEAT_INTERVAL_MS. */
  intervalMs: number;
}

/** True when a content-free "still working" pulse should fire now.
 * Fires only while a turn is in flight, never while audio is already
 * playing (so it cannot overlap real speech), never in notes mode, and
 * only after intervalMs of continuous silence. */
export function shouldHeartbeat(g: HeartbeatGate): boolean {
  if (g.mode === 'notes') return false;
  if (!g.awaitingSince) return false;
  if (g.ttsActive) return false;
  const silentSince = Math.max(g.awaitingSince, g.lastSpeechMs);
  return g.now - silentSince >= g.intervalMs;
}
