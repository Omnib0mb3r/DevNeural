import { describe, it, expect, beforeEach } from "vitest";
import {
  RESTART_DEADLINE_MS,
  RESTART_PROGRESS_NOTE_AFTER_MS,
  clearPersistedRestart,
  isPersistedRestartFresh,
  readPersistedRestart,
  restartWaitStage,
  writePersistedRestart,
} from "@/lib/restart-state";

describe("isPersistedRestartFresh", () => {
  it("is fresh at age 0", () => {
    expect(isPersistedRestartFresh(1_000, 1_000)).toBe(true);
  });

  it("is fresh just under the 15-minute deadline", () => {
    const started = 1_000;
    const now = started + RESTART_DEADLINE_MS - 1;
    expect(isPersistedRestartFresh(started, now)).toBe(true);
  });

  it("is stale exactly at the 15-minute deadline", () => {
    const started = 1_000;
    const now = started + RESTART_DEADLINE_MS;
    expect(isPersistedRestartFresh(started, now)).toBe(false);
  });

  it("is stale well past the deadline", () => {
    const started = 1_000;
    const now = started + RESTART_DEADLINE_MS * 4;
    expect(isPersistedRestartFresh(started, now)).toBe(false);
  });

  it("rejects a timestamp in the future (clock skew guard)", () => {
    expect(isPersistedRestartFresh(2_000, 1_000)).toBe(false);
  });
});

describe("restartWaitStage", () => {
  it("is normal before the 90s progress-note threshold", () => {
    expect(restartWaitStage(0)).toBe("normal");
    expect(restartWaitStage(RESTART_PROGRESS_NOTE_AFTER_MS - 1)).toBe("normal");
  });

  it("is slow from 90s up to (not including) the 15-minute deadline", () => {
    expect(restartWaitStage(RESTART_PROGRESS_NOTE_AFTER_MS)).toBe("slow");
    expect(restartWaitStage(RESTART_DEADLINE_MS - 1)).toBe("slow");
  });

  it("is timed_out at and past the 15-minute deadline", () => {
    expect(restartWaitStage(RESTART_DEADLINE_MS)).toBe("timed_out");
    expect(restartWaitStage(RESTART_DEADLINE_MS * 2)).toBe("timed_out");
  });
});

describe("persisted restart read/write/clear", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when nothing is persisted", () => {
    expect(readPersistedRestart()).toBeNull();
  });

  it("round-trips a written timestamp", () => {
    writePersistedRestart(12_345);
    expect(readPersistedRestart()).toEqual({ startedAtMs: 12_345 });
  });

  it("clears the persisted entry", () => {
    writePersistedRestart(12_345);
    clearPersistedRestart();
    expect(readPersistedRestart()).toBeNull();
  });

  it("ignores garbage JSON instead of throwing", () => {
    window.localStorage.setItem("devneural.daemonRestart.pending", "{not json");
    expect(readPersistedRestart()).toBeNull();
  });

  it("ignores a payload with a non-numeric startedAtMs", () => {
    window.localStorage.setItem(
      "devneural.daemonRestart.pending",
      JSON.stringify({ startedAtMs: "soon" }),
    );
    expect(readPersistedRestart()).toBeNull();
  });

  it("ignores a payload missing startedAtMs entirely", () => {
    window.localStorage.setItem("devneural.daemonRestart.pending", JSON.stringify({}));
    expect(readPersistedRestart()).toBeNull();
  });
});
