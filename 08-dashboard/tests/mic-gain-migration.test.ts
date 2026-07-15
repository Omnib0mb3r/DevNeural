/* Legacy voice-slider migrations (2026-07-15). Two stale placebo-era
 * settings became live mutes when the VAD wiring was fixed: a
 * near-zero mic gain (now feeds VAD triggering) and a 6000ms pause
 * tolerance (now a real redemption window demanding 6s of unbroken
 * silence). Each migrates to a sane value exactly once, marked in
 * localStorage so deliberate post-fix settings are respected. */
import { describe, it, expect, beforeEach } from "vitest";
import {
  MIC_GAIN_LEGACY_FLOOR,
  MIC_GAIN_MIGRATED_KEY,
  VAD_REDEMPTION_LEGACY_CEILING_MS,
  VAD_REDEMPTION_MIGRATED_KEY,
  migrateLegacyMicGain,
  migrateLegacyVadRedemption,
} from "@/lib/mic-gain-migration";

const GAIN_KEY = "lex-mic-gain";
const REDEMPTION_KEY = "lex-vad-redemption-ms";

beforeEach(() => {
  window.localStorage.clear();
});

describe("migrateLegacyMicGain", () => {
  it("resets a placebo-era near-mute gain to 1.0 once and fires the correction", () => {
    const posted: number[] = [];
    const out = migrateLegacyMicGain(0.05, {
      storageKey: GAIN_KEY,
      postCorrection: (c) => posted.push(c),
    });
    expect(out).toBe(1.0);
    expect(posted).toEqual([1.0]);
    expect(window.localStorage.getItem(MIC_GAIN_MIGRATED_KEY)).toBe("1");
    expect(window.localStorage.getItem(GAIN_KEY)).toBe("1");
  });

  it("passes healthy values through untouched", () => {
    const posted: number[] = [];
    const out = migrateLegacyMicGain(MIC_GAIN_LEGACY_FLOOR, {
      storageKey: GAIN_KEY,
      postCorrection: (c) => posted.push(c),
    });
    expect(out).toBe(MIC_GAIN_LEGACY_FLOOR);
    expect(posted).toEqual([]);
    expect(window.localStorage.getItem(MIC_GAIN_MIGRATED_KEY)).toBeNull();
  });

  it("respects a deliberate post-migration low setting", () => {
    window.localStorage.setItem(MIC_GAIN_MIGRATED_KEY, "1");
    const posted: number[] = [];
    const out = migrateLegacyMicGain(0.05, {
      storageKey: GAIN_KEY,
      postCorrection: (c) => posted.push(c),
    });
    expect(out).toBe(0.05);
    expect(posted).toEqual([]);
  });

  it("ignores NaN (fresh install with no stored value)", () => {
    const posted: number[] = [];
    const out = migrateLegacyMicGain(NaN, {
      storageKey: GAIN_KEY,
      postCorrection: (c) => posted.push(c),
    });
    expect(Number.isNaN(out)).toBe(true);
    expect(posted).toEqual([]);
    expect(window.localStorage.getItem(MIC_GAIN_MIGRATED_KEY)).toBeNull();
  });
});

describe("migrateLegacyVadRedemption", () => {
  it("resets a placebo-era 6000ms redemption to the default once", () => {
    const posted: number[] = [];
    const out = migrateLegacyVadRedemption(6000, {
      storageKey: REDEMPTION_KEY,
      defaultMs: 768,
      postCorrection: (c) => posted.push(c),
    });
    expect(out).toBe(768);
    expect(posted).toEqual([768]);
    expect(window.localStorage.getItem(VAD_REDEMPTION_MIGRATED_KEY)).toBe("1");
    expect(window.localStorage.getItem(REDEMPTION_KEY)).toBe("768");
  });

  it("passes values at or under the legacy ceiling through untouched", () => {
    const posted: number[] = [];
    const out = migrateLegacyVadRedemption(VAD_REDEMPTION_LEGACY_CEILING_MS, {
      storageKey: REDEMPTION_KEY,
      defaultMs: 768,
      postCorrection: (c) => posted.push(c),
    });
    expect(out).toBe(VAD_REDEMPTION_LEGACY_CEILING_MS);
    expect(posted).toEqual([]);
  });

  it("respects a deliberate post-migration high setting", () => {
    window.localStorage.setItem(VAD_REDEMPTION_MIGRATED_KEY, "1");
    const posted: number[] = [];
    const out = migrateLegacyVadRedemption(5000, {
      storageKey: REDEMPTION_KEY,
      defaultMs: 768,
      postCorrection: (c) => posted.push(c),
    });
    expect(out).toBe(5000);
    expect(posted).toEqual([]);
  });

  it("ignores NaN", () => {
    const posted: number[] = [];
    const out = migrateLegacyVadRedemption(NaN, {
      storageKey: REDEMPTION_KEY,
      defaultMs: 768,
      postCorrection: (c) => posted.push(c),
    });
    expect(Number.isNaN(out)).toBe(true);
    expect(posted).toEqual([]);
  });
});
