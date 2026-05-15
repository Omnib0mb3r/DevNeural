/**
 * voice-log unit tests.
 *
 * Pins the ring-buffer contract (push, cap, custom event) and the
 * exponential-backoff schedule used by the WS auto-reconnect path.
 * Both behaviours regression-test the voice-loop-restart escalation:
 * without auto-reconnect the user had to manually click "start voice"
 * after every transient WS drop, and without a visible log they had
 * no way to know voice had died until they noticed Lex wasn't
 * responding.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VOICE_LOG_CAP,
  VOICE_LOG_EVENT_NAME,
  computeReconnectBackoffMs,
  getVoiceLog,
  logVoice,
  _resetVoiceLog,
} from "../lib/voice-log";

beforeEach(() => {
  _resetVoiceLog();
});

afterEach(() => {
  _resetVoiceLog();
});

describe("logVoice ring buffer", () => {
  it("pushes entries with ts + level + kind + msg", () => {
    logVoice("ws-open", "voice ws connected");
    const log = getVoiceLog();
    expect(log).toHaveLength(1);
    expect(log[0]!.kind).toBe("ws-open");
    expect(log[0]!.level).toBe("info");
    expect(log[0]!.msg).toBe("voice ws connected");
    expect(typeof log[0]!.ts).toBe("string");
    expect(Date.parse(log[0]!.ts)).toBeGreaterThan(0);
  });

  it("respects the level argument", () => {
    logVoice("ws-error", "bad", undefined, "error");
    expect(getVoiceLog()[0]!.level).toBe("error");
  });

  it("caps the ring at VOICE_LOG_CAP entries (oldest dropped first)", () => {
    for (let i = 0; i < VOICE_LOG_CAP + 50; i++) {
      logVoice("ws-open", `entry-${i}`);
    }
    const log = getVoiceLog();
    expect(log.length).toBe(VOICE_LOG_CAP);
    /* The first entry kept should be (TOTAL - CAP)th push, so the
     * msg should reflect the trimmed range. */
    expect(log[0]!.msg).toBe(`entry-50`);
    expect(log[log.length - 1]!.msg).toBe(`entry-${VOICE_LOG_CAP + 49}`);
  });

  it("emits the lex-voice-log-append custom event on every push", () => {
    const events: string[] = [];
    const handler = (e: Event) => {
      events.push((e as CustomEvent).detail?.msg ?? "?");
    };
    window.addEventListener(VOICE_LOG_EVENT_NAME, handler);
    try {
      logVoice("ws-open", "a");
      logVoice("ws-close", "b");
    } finally {
      window.removeEventListener(VOICE_LOG_EVENT_NAME, handler);
    }
    expect(events).toEqual(["a", "b"]);
  });
});

describe("computeReconnectBackoffMs", () => {
  it("returns 1000ms +/- 20% jitter on attempt 0", () => {
    for (let i = 0; i < 50; i++) {
      const v = computeReconnectBackoffMs(0);
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1200);
    }
  });

  it("doubles on each attempt up to the cap", () => {
    /* Sample many times to cancel jitter; assert the running mean
     * approximates the canonical schedule (1s → 2s → 4s → 8s →
     * 16s → 30s cap). The 30s cap kicks in around attempt 5
     * (1000 * 2^5 = 32000 > 30000). */
    const trials = 200;
    const means = [0, 1, 2, 3, 4, 5, 6].map((attempt) => {
      let sum = 0;
      for (let i = 0; i < trials; i++) sum += computeReconnectBackoffMs(attempt);
      return sum / trials;
    });
    expect(means[0]!).toBeGreaterThan(800);
    expect(means[0]!).toBeLessThan(1200);
    expect(means[1]!).toBeGreaterThan(1700);
    expect(means[1]!).toBeLessThan(2300);
    expect(means[2]!).toBeGreaterThan(3500);
    expect(means[2]!).toBeLessThan(4500);
    /* Once base hits the 30s cap, the mean across many samples is
     * 30s +/- statistical noise from the jitter. Allow a wider band
     * around the cap so this assertion does not flake. */
    expect(means[5]!).toBeLessThanOrEqual(31_500);
    expect(means[6]!).toBeLessThanOrEqual(31_500);
    expect(means[5]!).toBeGreaterThanOrEqual(28_500);
    expect(means[6]!).toBeGreaterThanOrEqual(28_500);
  });

  it("caps at 30s even on large attempt counts", () => {
    for (let a = 6; a < 12; a++) {
      const v = computeReconnectBackoffMs(a);
      expect(v).toBeLessThanOrEqual(36_000); /* 30s + 20% jitter ceiling */
      expect(v).toBeGreaterThanOrEqual(24_000); /* 30s - 20% jitter floor */
    }
  });

  it("never returns less than 500ms (lower clamp)", () => {
    for (let i = 0; i < 100; i++) {
      expect(computeReconnectBackoffMs(0)).toBeGreaterThanOrEqual(500);
    }
  });
});
