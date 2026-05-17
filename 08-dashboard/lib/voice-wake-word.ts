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
  | "end_session"
  | "standby"
  | "listen";

const LEX_PREFIX = String.raw`\blex\s+`;

const PANIC_RE = new RegExp(LEX_PREFIX + String.raw`emergency\s+stop\b`);
const END_SESSION_RE = new RegExp(LEX_PREFIX + String.raw`end\s+session\b`);
const MUTE_RE = new RegExp(
  LEX_PREFIX + String.raw`(?:mute|shut\s+up|be\s+quiet|stop\s+talking)\b`,
);
/* Unmute synonyms. Mirrors the daemon-side matcher; see
 * 07-daemon/src/voice/lex-voice-commands.ts for the canonical doc. */
const UNMUTE_RE = new RegExp(
  LEX_PREFIX +
    String.raw`(?:unmute|resume(?!\s+listening)|come\s+back|you\s+can\s+talk|start\s+talking\s+again)\b`,
);
const STANDBY_RE = new RegExp(
  LEX_PREFIX + String.raw`(?:stand\s+by|pause\s+listening|hold\s+on)\b`,
);
const LISTEN_RE = new RegExp(
  LEX_PREFIX + String.raw`(?:listen|resume\s+listening|i\s+m\s+back)\b`,
);
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
  /* STANDBY + LISTEN before UNMUTE so qualified "resume listening"
   * lands on listen and bare "lex resume" lands on unmute. */
  if (STANDBY_RE.test(norm)) return "standby";
  if (LISTEN_RE.test(norm)) return "listen";
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
export interface SpeechRecognitionAlternativeLike {
  transcript: string;
  /** Confidence is optional on older Chromium builds. */
  confidence?: number;
}
export interface SpeechRecognitionResultLike
  extends ArrayLike<SpeechRecognitionAlternativeLike> {
  /** True once Web Speech finalises the fragment. Optional because
   * older builds skip it. */
  isFinal?: boolean;
}
/** Result event Web Speech delivers to onresult. In continuous mode
 * results[] keeps growing across the lifetime of the recognizer;
 * resultIndex is the spec-mandated cursor into NEW results that
 * arrived on this event. Anything before resultIndex has already
 * been delivered in a prior event - re-iterating from 0 re-matches
 * old finalised fragments and causes the very bug this module
 * exists to prevent. */
export interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
  resultIndex?: number;
}
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface WakeCandidateInfo {
  transcript: string;
  matched: VoiceCommandKind | null;
  confidence: number | null;
  isFinal: boolean;
  resultIndex: number;
  altIndex: number;
}

export interface ProcessWakeResultsOptions {
  /** Fires once per matched result fragment. The wake-word path's
   * dedupe guard lives downstream of this callback. */
  dispatch: (kind: VoiceCommandKind) => void;
  /** Optional candidate observer. Fires for every alternative the
   * walker visits (whether or not the matcher locked a kind) so
   * the consumer can drive logging / a debug badge without having
   * to re-walk results. */
  onCandidate?: (info: WakeCandidateInfo) => void;
}

/**
 * Walk the NEW results on a Web Speech recognition event and
 * dispatch matched wake-words.
 *
 * Critical detail: iterates from `event.resultIndex` (default 0
 * for older builds that omit the field) rather than 0. Web Speech
 * in continuous mode never trims event.results between events -
 * every finalised fragment from the lifetime of the recognizer
 * stays at its original index. Iterating from 0 re-matches old
 * fragments (e.g. an earlier "lex shut up") forever; the 1500ms
 * per-kind dedupe holds for the first burst then wears off, and
 * the same command fires every ~1.5s. resultIndex is the
 * spec-defined cursor into "what's new on THIS event".
 *
 * Inner alt loop bails on the first match so a single result with
 * two competing alternatives can't double-dispatch. dispatchWake
 * Command's per-kind dedupe still catches a burst of interim
 * fragments that all read the same matched kind.
 */
export function processWakeResults(
  event: SpeechRecognitionEventLike,
  opts: ProcessWakeResultsOptions,
): void {
  const start =
    typeof event.resultIndex === "number" && event.resultIndex >= 0
      ? event.resultIndex
      : 0;
  for (let i = start; i < event.results.length; i++) {
    const alts = event.results[i]!;
    const isFinal = alts.isFinal === true;
    for (let j = 0; j < alts.length; j++) {
      const alt = alts[j];
      const candidate = alt?.transcript ?? "";
      const confidence =
        typeof alt?.confidence === "number" ? alt.confidence : null;
      const kind = matchWakeWord(candidate);
      opts.onCandidate?.({
        transcript: candidate,
        matched: kind,
        confidence,
        isFinal,
        resultIndex: i,
        altIndex: j,
      });
      if (kind) {
        opts.dispatch(kind);
        break;
      }
    }
  }
}
