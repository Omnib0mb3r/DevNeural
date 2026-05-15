/**
 * Voice pipeline observability ring buffer.
 *
 * Mirrors wake-log.ts but covers the broader voice pipeline -- WS
 * connect / disconnect / reconnect-attempt, mic permission grants,
 * VAD state transitions, and any error surface. Both panels feed
 * into the dashboard's Voice diagnostics surface so the user can
 * see WHY voice stopped working without opening DevTools.
 *
 * Pure module with one side effect (window mutation). No engine
 * behavior depends on this; removing it would not change voice-
 * pipeline semantics. Read the ring buffer from any consumer with
 * getVoiceLog(); React panels can poll it on a short interval to
 * render a live tail. A custom event 'lex-voice-log-append' fires
 * after every push so panels can re-render without polling when
 * they would rather subscribe.
 */

export const VOICE_LOG_CAP = 100;

export type VoiceLogLevel = "info" | "warn" | "error";

export type VoiceLogKind =
  | "ws-open"
  | "ws-close"
  | "ws-error"
  | "ws-reconnect-scheduled"
  | "ws-reconnect-giveup"
  | "mic-permission-prompt"
  | "mic-permission-granted"
  | "mic-permission-denied"
  | "vad-start"
  | "vad-stop"
  | "vad-error"
  | "audio-context-state"
  | "wake-watchdog-restart"
  | "engine-enable"
  | "engine-disable"
  | "tts-start"
  | "tts-end"
  | "error";

export interface VoiceLogEntry {
  ts: string;
  level: VoiceLogLevel;
  kind: VoiceLogKind;
  msg: string;
  data?: unknown;
}

declare global {
  interface Window {
    __lexVoiceLog?: VoiceLogEntry[];
  }
}

const VOICE_LOG_EVENT = "lex-voice-log-append";

export function logVoice(
  kind: VoiceLogKind,
  msg: string,
  data?: unknown,
  level: VoiceLogLevel = "info",
): void {
  const entry: VoiceLogEntry = {
    ts: new Date().toISOString(),
    level,
    kind,
    msg,
  };
  if (data !== undefined) entry.data = data;
  if (typeof window !== "undefined") {
    if (!window.__lexVoiceLog) window.__lexVoiceLog = [];
    window.__lexVoiceLog.push(entry);
    if (window.__lexVoiceLog.length > VOICE_LOG_CAP) {
      window.__lexVoiceLog.splice(
        0,
        window.__lexVoiceLog.length - VOICE_LOG_CAP,
      );
    }
    try {
      window.dispatchEvent(new CustomEvent(VOICE_LOG_EVENT, { detail: entry }));
    } catch {
      /* CustomEvent unavailable in some test envs; not fatal */
    }
  }
  /* Mirror to console with a stable prefix so live tailing in
   * DevTools works without reading the ring buffer. */
  const prefix = `[voice:${kind}]`;
  if (level === "error") {
    if (data !== undefined) console.error(prefix, msg, data);
    else console.error(prefix, msg);
  } else if (level === "warn") {
    if (data !== undefined) console.warn(prefix, msg, data);
    else console.warn(prefix, msg);
  } else {
    if (data !== undefined) console.log(prefix, msg, data);
    else console.log(prefix, msg);
  }
}

export function getVoiceLog(): VoiceLogEntry[] {
  if (typeof window === "undefined") return [];
  return [...(window.__lexVoiceLog ?? [])];
}

/** Test seam: clear the ring + remove the listener. */
export function _resetVoiceLog(): void {
  if (typeof window !== "undefined") {
    window.__lexVoiceLog = [];
  }
}

export const VOICE_LOG_EVENT_NAME = VOICE_LOG_EVENT;

/** Compute backoff in ms for an attempt number. Returns the standard
 * exponential schedule 1s → 2s → 4s → 8s → 16s → 30s (cap) with
 * +/- 20% jitter so a herd of clients reconnecting after a daemon
 * restart spreads out instead of dog-piling. Pure helper exposed so
 * the regression test can pin the schedule. */
export function computeReconnectBackoffMs(attempt: number): number {
  const base = Math.min(30_000, 1_000 * Math.pow(2, Math.max(0, attempt)));
  const jitter = base * (0.4 * Math.random() - 0.2);
  return Math.max(500, Math.floor(base + jitter));
}
