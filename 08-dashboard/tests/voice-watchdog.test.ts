/**
 * voice-watchdog unit tests.
 *
 * Two contracts:
 *
 *  1. runWatchdogChecks() — the pure probe function. Pins the
 *     ttsActive gating and the two time gates so a refactor cannot
 *     silently change when a check fails.
 *
 *  2. failsWarrantBanner() — the reclassification that kills the
 *     false "voice dead" banner. Standing operator rule: NO
 *     time-based voice errors. A buffer/frame stall heals silently
 *     and must NEVER raise the user-visible dead banner; only a
 *     genuine subsystem fault (a dead AudioContext that will not
 *     resume) may. These tests are the regression guard for the
 *     "long Lex reply pops up 'voice dead' but it's a lie" bug.
 */
import { describe, expect, it } from "vitest";
import {
  BUFFER_STALL_MS,
  FRAME_TIMEOUT_MS,
  REAL_FAULT_KINDS,
  failsWarrantBanner,
  runWatchdogChecks,
  type WatchdogProbeState,
} from "../lib/voice-watchdog";

const base: WatchdogProbeState = {
  ctxState: "running",
  ttsActive: false,
  lastFrameTsMs: null,
  activeBufferCount: 0,
  lastBufferProgressTsMs: null,
};

function kindsFailing(results: { kind: string; ok: boolean }[]): string[] {
  return results.filter((r) => !r.ok).map((r) => r.kind);
}

describe("runWatchdogChecks", () => {
  it("passes a healthy running context when idle (no tts gates)", () => {
    const r = runWatchdogChecks({ ...base }, 1_000_000);
    expect(kindsFailing(r)).toEqual([]);
    // time gates only run while ttsActive
    expect(r.map((c) => c.kind)).toEqual(["ctx_state"]);
  });

  it("flags ctx_state when the context is suspended, tts or not", () => {
    const r = runWatchdogChecks({ ...base, ctxState: "suspended" }, 1_000_000);
    expect(kindsFailing(r)).toContain("ctx_state");
  });

  it("does not run the time gates while idle even with a stale frame", () => {
    const now = 1_000_000;
    const r = runWatchdogChecks(
      { ...base, ttsActive: false, lastFrameTsMs: now - FRAME_TIMEOUT_MS - 1 },
      now,
    );
    expect(kindsFailing(r)).toEqual([]);
  });

  it("fails frame_timeout when tts active and frames are stale", () => {
    const now = 1_000_000;
    const r = runWatchdogChecks(
      { ...base, ttsActive: true, lastFrameTsMs: now - FRAME_TIMEOUT_MS - 1 },
      now,
    );
    expect(kindsFailing(r)).toContain("frame_timeout");
  });

  it("fails buffer_stuck when tts active, buffers scheduled, clock stalled", () => {
    const now = 1_000_000;
    const r = runWatchdogChecks(
      {
        ...base,
        ttsActive: true,
        lastFrameTsMs: now, // fresh frame, isolate buffer check
        activeBufferCount: 2,
        lastBufferProgressTsMs: now - BUFFER_STALL_MS - 1,
      },
      now,
    );
    expect(kindsFailing(r)).toContain("buffer_stuck");
  });
});

describe("failsWarrantBanner (no time-based errors)", () => {
  it("a frame_timeout stall alone never raises the banner", () => {
    expect(failsWarrantBanner(["frame_timeout"])).toBe(false);
  });

  it("a buffer_stuck stall alone never raises the banner", () => {
    expect(failsWarrantBanner(["buffer_stuck"])).toBe(false);
  });

  it("both time-based stalls together still never raise the banner", () => {
    expect(failsWarrantBanner(["buffer_stuck", "frame_timeout"])).toBe(false);
  });

  it("a genuine ctx_state fault raises the banner", () => {
    expect(failsWarrantBanner(["ctx_state"])).toBe(true);
  });

  it("a real fault mixed with time stalls still raises the banner", () => {
    expect(failsWarrantBanner(["ctx_state", "frame_timeout"])).toBe(true);
  });

  it("no failing checks means no banner", () => {
    expect(failsWarrantBanner([])).toBe(false);
  });

  it("REAL_FAULT_KINDS is ctx_state only — the time gates are excluded", () => {
    expect(REAL_FAULT_KINDS).toContain("ctx_state");
    expect(REAL_FAULT_KINDS).not.toContain("frame_timeout");
    expect(REAL_FAULT_KINDS).not.toContain("buffer_stuck");
  });
});
