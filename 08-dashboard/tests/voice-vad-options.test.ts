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

describe("vadThresholds", () => {
  it("matches the legacy 0.5/0.4 pair at sensitivity 0.5", () => {
    const t = vadThresholds(0.5);
    expect(t.positive).toBeCloseTo(0.5, 5);
    expect(t.negative).toBeCloseTo(0.4, 5);
  });

  it("lowers thresholds as sensitivity rises", () => {
    const low = vadThresholds(0);
    const high = vadThresholds(1);
    expect(low.positive).toBeCloseTo(0.7, 5);
    expect(high.positive).toBeCloseTo(0.3, 5);
    expect(high.positive).toBeLessThan(low.positive);
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
