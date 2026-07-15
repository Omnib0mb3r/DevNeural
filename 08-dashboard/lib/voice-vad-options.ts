/* Pure helpers for building the @ricky0123/vad-web option set.
 *
 * The installed vad-web (0.0.30) forwards ONLY the allowlisted
 * ms-based FrameProcessorOptions keys into its internal FrameProcessor:
 * positiveSpeechThreshold, negativeSpeechThreshold, redemptionMs,
 * preSpeechPadMs, minSpeechMs, submitUserSpeechOnPause. Legacy frame-
 * count keys (redemptionFrames, preSpeechPadFrames, minSpeechFrames)
 * are silently ignored because MicVAD.new constructs its FrameProcessor
 * from an explicit object literal of those six keys, not a spread of
 * the full options object (see node_modules/@ricky0123/vad-web/dist/
 * real-time-vad.js, static MicVAD.new). This module is the single
 * source of truth for the ms-based option set so VoiceClient's initial
 * MicVAD.new call and its live setOptions() calls (vad_sensitivity /
 * vad_redemption_ms updates) can never drift apart.
 */

/* Fixed pre-speech padding + minimum speech duration, in ms. Not user-
 * tunable today; kept as named constants so VoiceClient and its tests
 * share one definition instead of a repeated magic number. 256ms
 * mirrors the previous (non-functional, silently-dropped) frame-count
 * intent of preSpeechPadFrames: 8 / minSpeechFrames: 8. */
export const VAD_PRE_SPEECH_PAD_MS = 256;
export const VAD_MIN_SPEECH_MS = 256;

/* Map a 0-1 sensitivity knob to silero positive/negative speech
 * thresholds. Higher knob = more sensitive = lower threshold. The
 * 0.1 delta between positive and negative matches the legacy tuning
 * (positive 0.5 / negative 0.4 at sensitivity 0.5). */
export function vadThresholds(sensitivity: number): {
  positive: number;
  negative: number;
} {
  const s = Math.max(0, Math.min(1, sensitivity));
  const positive = 0.7 - 0.4 * s;
  const negative = positive - 0.1;
  return { positive, negative };
}

export interface VadOptionSet {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  redemptionMs: number;
  preSpeechPadMs: number;
  minSpeechMs: number;
}

/* Build the full ms-based option set vad-web actually reads, from the
 * two user-tunable knobs (mic sensitivity, pause-tolerance redemption
 * window). Used both at MicVAD.new init time and for live
 * vad.setOptions() calls so the running instance and a fresh init
 * always agree. */
export function buildVadOptionSet(
  sensitivity: number,
  redemptionMs: number,
): VadOptionSet {
  const t = vadThresholds(sensitivity);
  return {
    positiveSpeechThreshold: t.positive,
    negativeSpeechThreshold: t.negative,
    redemptionMs,
    preSpeechPadMs: VAD_PRE_SPEECH_PAD_MS,
    minSpeechMs: VAD_MIN_SPEECH_MS,
  };
}
