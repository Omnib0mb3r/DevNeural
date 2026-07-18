/**
 * Voice status display mapping - single source of truth.
 *
 * Both status surfaces (the full voice panel header in VoiceClient
 * and the TopBar VoicePillView) render their label through this
 * module. They used to carry two divergent inline maps, which let
 * the pill drift into showing "muted (tts)" while Lex was audibly
 * speaking (bug: the overlay ternary keyed on micGated, which is
 * true for the whole TTS playback window, and its label described
 * the inverse of reality - the MIC is what the gate pauses, not
 * the TTS).
 *
 * Status values mirror the client voice pipeline exactly; every
 * member is reachable (audited 2026-07-16 against the post-phase-2
 * pipeline: streaming partials + semantic endpointing changed no
 * client-visible states):
 *   idle          voice off (initial, teardown, "lex disable")
 *   connecting    WS dialing / reconnect backoff
 *   ready         hello-ack landed; mic armed, nothing in flight
 *   listening     VAD open, utterance being captured
 *   transcribing  utterance shipped, whisper running
 *   thinking      transcript injected, waiting on the brain
 *   speaking      tts-start received, PCM playing
 *   error         WS / mic / audio failure
 */
export type VoiceStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

/* Base label per status. Short lowercase forms: the pill uppercases
 * via CSS and the panel renders them raw next to the "Voice"
 * heading, so the strings must read correctly in both cases. */
export const VOICE_STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: "off",
  connecting: "connecting",
  ready: "ready",
  listening: "listening",
  transcribing: "transcribing",
  thinking: "thinking",
  speaking: "speaking",
  error: "error",
};

/* Phase 2 R2 / acceptance-3: pressing Start voice starts the TOP
 * (Lex voice) headless session; the control shows "connecting" until
 * that session reports warm, then goes live ("ready"). hello-ack (the
 * WS bind) is necessary but NOT sufficient - the socket being up does
 * not mean the top layer can answer yet, and telling the operator the
 * line is live before then is the no-audio incident (they speak into a
 * not-yet-warm brain). The daemon sends a `voice-brain` frame carrying
 * that readiness; this maps it to the pipeline status. */
export function voiceStatusForBrainReady(
  brainReady: boolean,
): "connecting" | "ready" {
  return brainReady ? "ready" : "connecting";
}

/* Which overlay, if any, replaced the base label. Surfaces key
 * their tone (text color) off this instead of re-deriving the
 * precedence themselves. */
export type VoiceStatusOverlay = "none" | "soft-muted" | "mic-paused";

export interface ResolvedVoiceStatus {
  label: string;
  overlay: VoiceStatusOverlay;
}

/**
 * Resolve the display label for the current pipeline status plus
 * the two mute overlays. Precedence, most-authoritative first:
 *
 *   1. softMuted - the user silenced Lex's TTS ("lex mute" or the
 *      speaker pill). Strongest signal: audio is being dropped on
 *      the floor until an explicit unmute, so the label must say
 *      so regardless of the underlying status. (tts-start early-
 *      breaks while softMuted, so "speaking" cannot legitimately
 *      co-occur; if a race lands one anyway, muted is the truth.)
 *   2. speaking - audible playback is never masked by micGated.
 *      The gate accompanies every TTS window by design (the mic
 *      pauses so playback does not loop back through whisper);
 *      labelling that window by the gate instead of the audio was
 *      the original "muted (tts)" bug.
 *   3. micGated - the mic is paused but nothing is audibly
 *      playing (transient: tts teardown clears the gate in the
 *      same tick it drops "speaking"). Say what the gate actually
 *      does: the MIC is paused. TTS is not muted here.
 *   4. base label.
 */
export function resolveVoiceStatusLabel(
  status: VoiceStatus,
  overlays: { softMuted: boolean; micGated: boolean },
): ResolvedVoiceStatus {
  if (overlays.softMuted) {
    return { label: "muted (voice)", overlay: "soft-muted" };
  }
  if (overlays.micGated && status !== "speaking") {
    return { label: "mic paused", overlay: "mic-paused" };
  }
  return { label: VOICE_STATUS_LABEL[status], overlay: "none" };
}
