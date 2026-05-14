/**
 * Wake-word observability ring buffer.
 *
 * Every [wake]-prefixed log line from VoiceClient.tsx routes through
 * logWake. The function does two things:
 *
 *   1. Persists the entry into a fixed-size ring buffer hung off
 *      window.__lexWakeLog (cap = WAKE_LOG_CAP). Read it from
 *      DevTools after the fact with `window.__lexWakeLog` to get
 *      the last 20 lifecycle / heard / dispatch events without
 *      having had to keep the console open while it happened.
 *
 *   2. Mirrors the entry to console.log with the canonical
 *      "[wake] <msg>" prefix so live tailing still works.
 *
 * Pure module with one side effect (window mutation). No engine
 * behavior depends on this; ripping it out would not change
 * voice-pipeline semantics.
 */

export const WAKE_LOG_CAP = 20;

export interface WakeLogEntry {
  ts: string;
  msg: string;
  data?: unknown;
}

declare global {
  interface Window {
    __lexWakeLog?: WakeLogEntry[];
  }
}

export function logWake(msg: string, data?: unknown): void {
  const entry: WakeLogEntry = { ts: new Date().toISOString(), msg };
  if (data !== undefined) entry.data = data;
  if (typeof window !== "undefined") {
    if (!window.__lexWakeLog) window.__lexWakeLog = [];
    window.__lexWakeLog.push(entry);
    if (window.__lexWakeLog.length > WAKE_LOG_CAP) {
      window.__lexWakeLog.splice(
        0,
        window.__lexWakeLog.length - WAKE_LOG_CAP,
      );
    }
  }
  if (data === undefined) {
    console.log(`[wake] ${msg}`);
  } else {
    console.log(`[wake] ${msg}`, data);
  }
}

/** Test seam: clear the ring buffer + every other observable side
 * effect. Not exposed in production code paths. */
export function _resetWakeLog(): void {
  if (typeof window !== "undefined") {
    window.__lexWakeLog = [];
  }
}
