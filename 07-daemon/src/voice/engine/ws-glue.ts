/**
 * Engine-to-WS glue: the pure decisions lex-voice-ws makes per
 * incoming transcript, extracted so the ordering contract is pinned by
 * tests instead of buried in the monolith.
 *
 * Order is the safety property:
 *   1. (panic stays in the WS layer - it must run before everything,
 *      including this glue.)
 *   2. Deterministic stop-class detection. Runs BEFORE the echo
 *      filter so a spoken "hold on" always interrupts even when Lex's
 *      own reply contained those words; the filter's own single-token
 *      immunity covers bare "stop" but not two-word stops.
 *   3. Echo filter: a transcript that is (fuzzily) Lex's own recent
 *      TTS is discarded before it can reach the top layer, the inject
 *      path, or the mid-turn queue.
 *   4. Everything else processes normally.
 *
 * Also owns the during-TTS window definition: the daemon's ttsActive
 * dies at synth-stream end, seconds before the client's speakers go
 * quiet; the window must extend to the client's playback-drained
 * signal (VOICE-TOP-LAYER-SPEC.md drain-window hole).
 */
import {
  classifyEcho,
  type EchoRegistry,
} from './echo-filter.js';
import {
  classifyStopUtterance,
  type StopClass,
} from './interrupt-arbiter.js';

export interface TranscriptVerdict {
  action: StopClass | 'echo-drop' | 'process';
  /** Content to forward (stop remainder, or the full text). */
  remainder: string;
  /** For echo-drop: the spoken line that matched. */
  echoMatched?: string;
  /** For echo-drop: the overlap score, for the log line. */
  echoScore?: number;
}

export function classifyIncomingTranscript(args: {
  text: string;
  echoRegistry: EchoRegistry;
  nowMs: number;
  /** Extended during-TTS flag; reserved for callers that want to
   * scope the echo check to playback windows. The filter's TTL
   * already bounds matches, so the check currently runs regardless:
   * echo arrives AFTER drain too (the whole drain-window hole). */
  duringTts: boolean;
}): TranscriptVerdict {
  const stop = classifyStopUtterance(args.text);
  if (stop.stop) {
    return { action: stop.stop, remainder: stop.remainder };
  }
  const echo = classifyEcho(args.text, args.echoRegistry, args.nowMs);
  if (echo.echo) {
    return {
      action: 'echo-drop',
      remainder: '',
      echoMatched: echo.matched ?? undefined,
      echoScore: echo.score,
    };
  }
  return { action: 'process', remainder: args.text };
}

export function extendedDuringTts(args: {
  ttsActive: boolean;
  clientPlaybackActive: boolean;
}): boolean {
  return args.ttsActive || args.clientPlaybackActive;
}
