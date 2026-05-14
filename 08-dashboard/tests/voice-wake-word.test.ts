/**
 * Client-side wake-word matcher + dedupe guard.
 *
 * The wake-word path runs in parallel with the silero VAD pipeline
 * so the Lex command suite still fires while TTS playback has
 * paused the gated mic capture. These tests pin both halves:
 *   - matchWakeWord agrees with the daemon's matcher on the five
 *     command kinds, the precedence (mute > disable for "lex stop
 *     talking"), case insensitivity, and the no-prefix negatives.
 *   - createDedupe blocks a same-kind re-fire within the window so
 *     a tight burst of interim Web Speech results + a trailing
 *     whisper transcript carrying the same phrase do not double-
 *     dispatch.
 *
 * "Lex shut up" during simulated TTS playback ends up as one
 * unsuppressed mute fire here; the VoiceClient maps that to
 * setSoftMuted(true), which cancels the in-flight TTS via
 * resetTtsPlayback regardless of the micGated state that gates the
 * VAD-driven path. That's the end-to-end behaviour the spec asked
 * for.
 */
import { describe, expect, it } from "vitest";
import {
  matchWakeWord,
  createDedupe,
} from "../lib/voice-wake-word";

describe("matchWakeWord", () => {
  it("matches the disable phrase", () => {
    expect(matchWakeWord("lex disable")).toBe("disable");
    expect(matchWakeWord("Lex, disable.")).toBe("disable");
  });

  it("matches the full mute family", () => {
    expect(matchWakeWord("lex mute")).toBe("mute");
    expect(matchWakeWord("lex shut up")).toBe("mute");
    expect(matchWakeWord("lex be quiet")).toBe("mute");
    expect(matchWakeWord("lex stop talking")).toBe("mute");
  });

  it('"lex stop talking" falls through to mute, not disable', () => {
    expect(matchWakeWord("lex stop talking")).toBe("mute");
  });

  it("matches unmute and refuses the reserved 'lex resume' phrase", () => {
    expect(matchWakeWord("lex unmute")).toBe("unmute");
    expect(matchWakeWord("lex resume")).toBeNull();
  });

  it("matches panic and end_session", () => {
    expect(matchWakeWord("lex emergency stop")).toBe("panic");
    expect(matchWakeWord("lex end session")).toBe("end_session");
  });

  it("requires the lex prefix on every command", () => {
    expect(matchWakeWord("emergency stop")).toBeNull();
    expect(matchWakeWord("shut up")).toBeNull();
    expect(matchWakeWord("disable")).toBeNull();
    expect(matchWakeWord("end session")).toBeNull();
  });

  it("survives mid-TTS interim transcripts that the Web Speech recognizer emits", () => {
    /* Web Speech results during simulated TTS playback look like
     * partial fragments while the user is still speaking. The
     * matcher does not care about leading filler. */
    expect(matchWakeWord("uh lex shut up please")).toBe("mute");
    expect(matchWakeWord("okay LEX  SHUT  UP!")).toBe("mute");
  });

  it("returns null on empty / whitespace input", () => {
    expect(matchWakeWord("")).toBeNull();
    expect(matchWakeWord("   ")).toBeNull();
  });
});

describe("createDedupe", () => {
  it("returns true on the first fire and false within the window for the same kind", () => {
    const guard = createDedupe(1500);
    expect(guard.shouldFire("mute", 1000)).toBe(true);
    expect(guard.shouldFire("mute", 1500)).toBe(false);
    expect(guard.shouldFire("mute", 2499)).toBe(false);
  });

  it("allows the same kind again after the window has passed", () => {
    const guard = createDedupe(1500);
    expect(guard.shouldFire("mute", 1000)).toBe(true);
    expect(guard.shouldFire("mute", 2500)).toBe(true);
  });

  it("tracks each kind independently", () => {
    const guard = createDedupe(1500);
    expect(guard.shouldFire("mute", 1000)).toBe(true);
    expect(guard.shouldFire("disable", 1000)).toBe(true);
    expect(guard.shouldFire("unmute", 1000)).toBe(true);
    expect(guard.shouldFire("mute", 1100)).toBe(false);
    expect(guard.shouldFire("disable", 1100)).toBe(false);
  });

  it("uses Date.now when no timestamp is supplied", () => {
    /* Smoke test: two calls in immediate succession should land in
     * the dedupe window without an explicit timestamp argument. */
    const guard = createDedupe(1500);
    expect(guard.shouldFire("panic")).toBe(true);
    expect(guard.shouldFire("panic")).toBe(false);
  });
});
