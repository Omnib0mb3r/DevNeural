/**
 * Persisted daemon-restart state.
 *
 * DaemonRestartCard's waiting UI used to live only in component state,
 * which a page refresh mid-outage threw away completely. Restarts can
 * legitimately take minutes: the Task Scheduler safety net only kicks
 * in after the relauncher silently fails, and historically ~18% of
 * restarts have taken longer than a few seconds, some up to ~10
 * minutes. This module gives the card a place to stash "a restart is
 * in flight, started at T" across reloads, plus the pure timing rules
 * (freshness for resume, progress-note threshold, failure deadline) so
 * a refresh does not either lose the waiting UI or wait forever on a
 * restart that failed silently long ago.
 */

const STORAGE_KEY = "devneural.daemonRestart.pending";

/** Shared 15-minute budget: how fresh a persisted restart must be to
 * resume the waiting UI on mount, and how long the waiting loop itself
 * polls before declaring failure. Kept as one constant because the
 * spec ties both numbers to the same figure. */
export const RESTART_DEADLINE_MS = 15 * 60 * 1000;

/** After this much elapsed time, the waiting UI admits the restart is
 * slow instead of staying silent. */
export const RESTART_PROGRESS_NOTE_AFTER_MS = 90 * 1000;

export interface PersistedRestart {
  startedAtMs: number;
}

export function readPersistedRestart(): PersistedRestart | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { startedAtMs?: unknown };
    if (typeof parsed.startedAtMs !== "number" || !Number.isFinite(parsed.startedAtMs)) {
      return null;
    }
    return { startedAtMs: parsed.startedAtMs };
  } catch {
    return null;
  }
}

export function writePersistedRestart(startedAtMs: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ startedAtMs }));
  } catch {
    /* storage may be disabled; silent no-op */
  }
}

export function clearPersistedRestart(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* no-op */
  }
}

/** True when `startedAtMs` is not in the future and is still within the
 * resume window relative to `nowMs`. Pure so the boundary math is
 * unit-testable without touching localStorage. */
export function isPersistedRestartFresh(startedAtMs: number, nowMs: number): boolean {
  const age = nowMs - startedAtMs;
  return age >= 0 && age < RESTART_DEADLINE_MS;
}

export type RestartWaitStage = "normal" | "slow" | "timed_out";

/** Given elapsed time since a restart was requested, decides which
 * honesty tier the waiting UI should show. Pure so the 90s / 15min
 * thresholds are covered by unit tests instead of only exercised by
 * clicking through a real restart. */
export function restartWaitStage(elapsedMs: number): RestartWaitStage {
  if (elapsedMs >= RESTART_DEADLINE_MS) return "timed_out";
  if (elapsedMs >= RESTART_PROGRESS_NOTE_AFTER_MS) return "slow";
  return "normal";
}
