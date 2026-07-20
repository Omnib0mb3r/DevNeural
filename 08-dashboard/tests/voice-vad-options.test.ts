/* Regression coverage for the ms-based vad-web option builder.
 *
 * Root cause: the installed @ricky0123/vad-web (0.0.30) only forwards
 * an allowlist of ms-based FrameProcessorOptions keys; legacy frame-
 * count keys (redemptionFrames, preSpeechPadFrames, minSpeechFrames)
 * are silently dropped. buildVadOptionSet is the single source of
 * truth VoiceClient uses both for the initial MicVAD.new call and for
 * live vad.setOptions() updates, so this file pins its shape and the
 * sensitivity -> threshold mapping it depends on.
 */
import { describe, expect, it } from "vitest";
import {
  VAD_MIN_SPEECH_MS,
  VAD_PRE_SPEECH_PAD_MS,
  buildVadOptionSet,
  vadThresholds,
} from "../lib/voice-vad-options";

describe("vadThresholds (rescaled 2026-07-20)", () => {
  it("spans 0.97 (near deaf) at 0 to 0.30 (very sensitive) at 1", () => {
    expect(vadThresholds(0).positive).toBeCloseTo(0.97, 5);
    expect(vadThresholds(1).positive).toBeCloseTo(0.3, 5);
  });

  it("keeps the low end near-deaf so a knob of 5 barely triggers", () => {
    /* display 5 = s 0.05 -> positive ~0.91: silero must be very
     * confident to clear it, which is the operator's ask. */
    const t = vadThresholds(0.05);
    expect(t.positive).toBeGreaterThan(0.88);
    expect(t.positive).toBeLessThan(0.94);
  });

  it("is monotonic: higher sensitivity always lowers the threshold", () => {
    let prev = Infinity;
    for (const s of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const p = vadThresholds(s).positive;
      expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it("puts the mid of the useful band (~0.585) around knob 50", () => {
    expect(vadThresholds(0.5).positive).toBeCloseTo(0.585, 2);
  });

  it("keeps a constant 0.1 gap between positive and negative", () => {
    for (const s of [0, 0.25, 0.5, 0.75, 1]) {
      const t = vadThresholds(s);
      expect(t.positive - t.negative).toBeCloseTo(0.1, 5);
    }
  });

  it("clamps out-of-range sensitivity to [0, 1]", () => {
    expect(vadThresholds(-5)).toEqual(vadThresholds(0));
    expect(vadThresholds(5)).toEqual(vadThresholds(1));
  });
});

describe("buildVadOptionSet", () => {
  it("returns only the ms-based keys vad-web actually reads", () => {
    const opts = buildVadOptionSet(0.5, 768);
    expect(Object.keys(opts).sort()).toEqual(
      [
        "positiveSpeechThreshold",
        "negativeSpeechThreshold",
        "redemptionMs",
        "preSpeechPadMs",
        "minSpeechMs",
      ].sort(),
    );
  });

  it("never emits legacy frame-count keys", () => {
    const opts = buildVadOptionSet(0.5, 768) as unknown as Record<
      string,
      unknown
    >;
    expect(opts.redemptionFrames).toBeUndefined();
    expect(opts.preSpeechPadFrames).toBeUndefined();
    expect(opts.minSpeechFrames).toBeUndefined();
  });

  it("passes redemptionMs through unchanged", () => {
    expect(buildVadOptionSet(0.5, 200).redemptionMs).toBe(200);
    expect(buildVadOptionSet(0.5, 6000).redemptionMs).toBe(6000);
  });

  it("derives thresholds from sensitivity via vadThresholds", () => {
    const opts = buildVadOptionSet(0.8, 500);
    const t = vadThresholds(0.8);
    expect(opts.positiveSpeechThreshold).toBe(t.positive);
    expect(opts.negativeSpeechThreshold).toBe(t.negative);
  });

  it("uses the fixed pad/min-speech constants", () => {
    const opts = buildVadOptionSet(0.5, 768);
    expect(opts.preSpeechPadMs).toBe(VAD_PRE_SPEECH_PAD_MS);
    expect(opts.minSpeechMs).toBe(VAD_MIN_SPEECH_MS);
  });

  it("produces a stable result for the same inputs (setOptions parity)", () => {
    /* VoiceClient calls this both at MicVAD.new time and again from
     * the live setOptions() path; the two must agree bit-for-bit
     * given the same sensitivity/redemption inputs. */
    const a = buildVadOptionSet(0.42, 900);
    const b = buildVadOptionSet(0.42, 900);
    expect(a).toEqual(b);
  });
});
