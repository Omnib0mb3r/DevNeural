/**
 * Word-gated barge-in (VOICE-TOP-LAYER-SPEC.md): during TTS playback a
 * silero VAD onset only ARMS a barge candidate; playback dies only when
 * streaming ASR yields at least 2 interim words (or 1 final word) that
 * do not match the TTS text. Raw-VAD interruption is the documented
 * OpenAI Realtime anti-pattern - noise kills playback - and is exactly
 * what the old pipeline had (utterance-start killed TTS
 * unconditionally, then a cooldown knob tried to paper over the
 * feedback loop it caused).
 *
 * Pure reducer: (state, event, deps) -> {state, fire}. The caller owns
 * the effects (actually stopping playback); `fire` is true exactly once
 * per armed cycle. Echo judgment is injected so this module stays free
 * of the echo-filter's registry.
 */

export interface BargeGateState {
  phase: 'idle' | 'armed' | 'fired';
  armedAtMs: number | null;
}

export type BargeGateEvent =
  | { type: 'vad-onset'; atMs: number; playbackActive: boolean }
  | { type: 'words'; kind: 'interim' | 'final'; text: string; atMs: number }
  | { type: 'phantom'; atMs: number }
  | { type: 'playback-idle'; atMs: number };

export interface BargeGateDeps {
  /** True when the words are (fuzzily) the TTS's own text. */
  isEchoText: (text: string) => boolean;
  /** Interim words needed to fire. Default 2. */
  minInterimWords?: number;
  /** An armed candidate older than this is stale; words that arrive
   * after the window belong to a different moment. Default 8s. */
  armTimeoutMs?: number;
}

const DEFAULT_MIN_INTERIM_WORDS = 2;
const DEFAULT_ARM_TIMEOUT_MS = 8_000;

export function createBargeGateState(): BargeGateState {
  return { phase: 'idle', armedAtMs: null };
}

function countWords(text: string): number {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

export function advanceBargeGate(
  state: BargeGateState,
  event: BargeGateEvent,
  deps: BargeGateDeps,
): { state: BargeGateState; fire: boolean } {
  const minInterim = deps.minInterimWords ?? DEFAULT_MIN_INTERIM_WORDS;
  const armTimeout = deps.armTimeoutMs ?? DEFAULT_ARM_TIMEOUT_MS;

  /* Stale arm decays before the event applies. */
  let cur = state;
  if (
    cur.phase === 'armed' &&
    cur.armedAtMs !== null &&
    event.atMs - cur.armedAtMs > armTimeout
  ) {
    cur = { phase: 'idle', armedAtMs: null };
  }

  switch (event.type) {
    case 'vad-onset': {
      if (!event.playbackActive) {
        /* Nothing playing: nothing to interrupt. The normal utterance
         * path handles this speech; the gate stays out of the way. */
        return { state: cur.phase === 'fired' ? cur : { phase: 'idle', armedAtMs: null }, fire: false };
      }
      if (cur.phase === 'fired') return { state: cur, fire: false };
      return { state: { phase: 'armed', armedAtMs: event.atMs }, fire: false };
    }
    case 'words': {
      if (cur.phase !== 'armed') return { state: cur, fire: false };
      const words = countWords(event.text);
      const enough =
        event.kind === 'final' ? words >= 1 : words >= minInterim;
      if (!enough) return { state: cur, fire: false };
      if (deps.isEchoText(event.text)) {
        /* The gate heard the assistant's own line: stay armed, more
         * (real) words may still arrive behind the echo. */
        return { state: cur, fire: false };
      }
      return { state: { phase: 'fired', armedAtMs: cur.armedAtMs }, fire: true };
    }
    case 'phantom':
    case 'playback-idle':
      return { state: { phase: 'idle', armedAtMs: null }, fire: false };
  }
}
