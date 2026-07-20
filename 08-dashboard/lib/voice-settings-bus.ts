/**
 * Cross-component channel for voice preference updates.
 *
 * VoiceSettingsPanel lives on /settings; the live VoiceClient is mounted
 * once at the app root (app/providers.tsx) so its WS / mic / VAD survive
 * navigation. Without a notification path, slider changes on /settings
 * persisted to the daemon but never reached the running capture pipeline:
 * the VoiceClient seeded its state from /voice/piper-status at mount and
 * never re-read it. Symptom: mic gain 0.3 and VAD sensitivity 0.15 had no
 * effect on the live capture path: the daemon kept hearing the user.
 *
 * This bus broadcasts a single same-window event the panel emits on every
 * persisted slider change. The VoiceClient subscribes once and updates
 * its own React state, which propagates into the refs that the capture
 * worklet reads on every audio frame. Gain applies immediately. The VAD
 * threshold / redemption knobs still need a VAD restart (silero ignores
 * live config), but the next start picks up the fresh value.
 */

export type VoiceSettingKey =
  | "mic_gain"
  | "vad_sensitivity"
  | "vad_redemption_ms"
  | "speed"
  | "active_voice"
  | "audio_output_device";

export interface VoiceSettingUpdate {
  key: VoiceSettingKey;
  value: number | string;
}

const EVENT_NAME = "lex:voice-settings-update";

export function emitVoiceSettingUpdate(update: VoiceSettingUpdate): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<VoiceSettingUpdate>(EVENT_NAME, { detail: update }),
  );
}

export function onVoiceSettingUpdate(
  cb: (update: VoiceSettingUpdate) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (e: Event): void => {
    const ce = e as CustomEvent<VoiceSettingUpdate>;
    if (ce.detail) cb(ce.detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
