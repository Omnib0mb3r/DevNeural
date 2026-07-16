/**
 * Voice status label mapping pins.
 *
 * Single source of truth for the status text shown by BOTH the
 * full voice panel header and the TopBar pill. History: the two
 * surfaces carried divergent inline maps, and the pill's overlay
 * ternary labelled micGated as "muted (tts)" - semantically
 * inverted (micGated means the MIC is paused while TTS plays) and
 * it masked "speaking" for the entire audible reply. These tests
 * pin the corrected mapping so neither surface can drift again.
 *
 * Overlay precedence, most-authoritative first:
 *   1. softMuted        -> "muted (voice)"  (user silenced Lex's TTS;
 *      tts-start early-breaks while softMuted so status can never be
 *      "speaking" here, but the override wins even if a race lands one)
 *   2. status=speaking  -> base label       (audible playback is NEVER
 *      masked by the mic gate that always accompanies it)
 *   3. micGated         -> "mic paused"     (defensive: gate normally
 *      exists only during playback, but if it outlives "speaking" the
 *      label says what is true - the mic is paused, not the TTS)
 *   4. otherwise        -> base label
 */
import { describe, expect, it } from "vitest";
import {
  VOICE_STATUS_LABEL,
  resolveVoiceStatusLabel,
  type VoiceStatus,
} from "../lib/voice-status";

const ALL_STATUSES: VoiceStatus[] = [
  "idle",
  "connecting",
  "ready",
  "listening",
  "transcribing",
  "thinking",
  "speaking",
  "error",
];

describe("VOICE_STATUS_LABEL", () => {
  it("maps every reachable pipeline status to its display label", () => {
    expect(VOICE_STATUS_LABEL).toEqual({
      idle: "off",
      connecting: "connecting",
      ready: "ready",
      listening: "listening",
      transcribing: "transcribing",
      thinking: "thinking",
      speaking: "speaking",
      error: "error",
    });
  });

  it("has no extra keys beyond the reachable status union", () => {
    expect(Object.keys(VOICE_STATUS_LABEL).sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
  });
});

describe("resolveVoiceStatusLabel", () => {
  it("returns the base label for every status when no overlay is active", () => {
    for (const status of ALL_STATUSES) {
      const r = resolveVoiceStatusLabel(status, {
        softMuted: false,
        micGated: false,
      });
      expect(r.label).toBe(VOICE_STATUS_LABEL[status]);
      expect(r.overlay).toBe("none");
    }
  });

  it("never masks speaking with the mic gate: micGated + speaking reads 'speaking'", () => {
    const r = resolveVoiceStatusLabel("speaking", {
      softMuted: false,
      micGated: true,
    });
    expect(r.label).toBe("speaking");
    expect(r.overlay).toBe("none");
  });

  it("labels a lingering mic gate as 'mic paused', not 'muted (tts)'", () => {
    for (const status of ALL_STATUSES.filter((s) => s !== "speaking")) {
      const r = resolveVoiceStatusLabel(status, {
        softMuted: false,
        micGated: true,
      });
      expect(r.label).toBe("mic paused");
      expect(r.overlay).toBe("mic-paused");
    }
  });

  it("labels soft mute as 'muted (voice)' for every underlying status", () => {
    for (const status of ALL_STATUSES) {
      const r = resolveVoiceStatusLabel(status, {
        softMuted: true,
        micGated: false,
      });
      expect(r.label).toBe("muted (voice)");
      expect(r.overlay).toBe("soft-muted");
    }
  });

  it("soft mute outranks the mic gate when both flags are up", () => {
    const r = resolveVoiceStatusLabel("ready", {
      softMuted: true,
      micGated: true,
    });
    expect(r.label).toBe("muted (voice)");
    expect(r.overlay).toBe("soft-muted");
  });

  it("never emits the retired 'muted (tts)' label under any flag combination", () => {
    for (const status of ALL_STATUSES) {
      for (const softMuted of [false, true]) {
        for (const micGated of [false, true]) {
          const r = resolveVoiceStatusLabel(status, { softMuted, micGated });
          expect(r.label).not.toBe("muted (tts)");
        }
      }
    }
  });
});
