/**
 * Client-side wake-word matcher for the Lex voice-command suite.
 *
 * The daemon already owns the canonical matcher
 * (07-daemon/src/voice/lex-voice-commands.ts), but the daemon's path
 * is gated by silero VAD + the micGated flag, both of which pause
 * during TTS playback. To let "Lex shut up" / "Lex disable" / etc.
 * actually halt Lex mid-sentence, this module powers a second
 * always-on pipeline in the browser: a small Web Speech API
 * recognizer (and a keyboard hotkey fallback) feeds short transcript
 * fragments into matchWakeWord, and the VoiceClient dispatches the
 * matched command directly.
 *
 * The matcher is intentionally a byte-for-byte port of the daemon's
 * matcher so both paths agree on phrasing and precedence; if either
 * is loosened we want the other to follow in the same commit.
 *
 * createDedupe returns a guard that suppresses a second fire for the
 * same command within the configured window. Used to keep the always-
 * on path and the whisper-transcript path from double-dispatching on
 * the same utterance (default 1500ms, matching the daemon-side
 * ConnState dedupe).
 */

export type VoiceCommandKind =
  | "disable"
  | "mute"
  | "unmute"
  | "panic"
  | "end_session";

const LEX_PREFIX = String.raw`\blex\s+`;

const PANIC_RE = new RegExp(LEX_PREFIX + String.raw`emergency\s+stop\b`);
const END_SESSION_RE = new RegExp(LEX_PREFIX + String.raw`end\s+session\b`);
const MUTE_RE = new RegExp(
  LEX_PREFIX + String.raw`(?:mute|shut\s+up|be\s+quiet|stop\s+talking)\b`,
);
const UNMUTE_RE = new RegExp(LEX_PREFIX + String.raw`unmute\b`);
const DISABLE_RE = new RegExp(LEX_PREFIX + String.raw`disable\b`);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchWakeWord(text: string): VoiceCommandKind | null {
  if (!text) return null;
  const norm = normalize(text);
  if (!norm) return null;
  if (PANIC_RE.test(norm)) return "panic";
  if (END_SESSION_RE.test(norm)) return "end_session";
  if (MUTE_RE.test(norm)) return "mute";
  if (UNMUTE_RE.test(norm)) return "unmute";
  if (DISABLE_RE.test(norm)) return "disable";
  return null;
}

export interface DedupeGuard {
  /** Returns true when the command should fire; false when it was
   * suppressed because the same kind fired within the dedupe window.
   * Side-effect on true: records the new timestamp so the next call
   * inside the window will be suppressed. */
  shouldFire(kind: VoiceCommandKind, now?: number): boolean;
}

export function createDedupe(windowMs: number = 1500): DedupeGuard {
  const last: Partial<Record<VoiceCommandKind, number>> = {};
  return {
    shouldFire(kind, now) {
      const t = now ?? Date.now();
      const prev = last[kind];
      if (prev !== undefined && t - prev < windowMs) return false;
      last[kind] = t;
      return true;
    },
  };
}

/**
 * Resolve the platform SpeechRecognition constructor when available.
 * Returns null on environments without browser STT (Firefox today,
 * jsdom in tests, offline boxes whose Chromium build lacks the
 * cloud STT backend). The caller is expected to fall back to the
 * keyboard hotkey path.
 */
export function getSpeechRecognitionCtor(): {
  new (): SpeechRecognitionLike;
} | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: { new (): SpeechRecognitionLike };
    webkitSpeechRecognition?: { new (): SpeechRecognitionLike };
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* Structural type for the bits of the Web Speech API surface we
 * touch. The real DOM lib types live behind a vendor-prefixed pair
 * (SpeechRecognition + webkitSpeechRecognition) that TypeScript's
 * default lib does not declare; redeclaring the whole surface would
 * be heavier than the few methods we actually call. */
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
