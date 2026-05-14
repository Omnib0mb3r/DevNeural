/**
 * Lex voice-command dispatch matcher (locked 2026-05-14).
 *
 * Every voice command must start with the literal word "lex" so the
 * matcher cannot false-fire on meeting chatter (the lex-voice WS
 * normalises whisper output to lower-cased, punctuation-stripped,
 * whitespace-collapsed text before reaching this matcher; the
 * normalize step is reproduced here so the standalone function can
 * be unit-tested on raw user input).
 *
 * Patterns are evaluated in a fixed priority order:
 *   1. panic        ("lex emergency stop")
 *   2. end_session  ("lex end session")
 *   3. mute         ("lex mute" / "lex shut up" / "lex be quiet" /
 *                    "lex stop talking")
 *   4. unmute       ("lex unmute")
 *   5. disable      ("lex disable")
 *
 * Mute precedes disable so "lex stop talking" lands on mute rather
 * than tripping a substring of "lex stop" (legacy disable phrasing
 * the spec explicitly accepts as benign-on-overlap). "lex resume" is
 * intentionally NOT wired to unmute; the phrase is reserved for a
 * future broader resume command.
 */

export type VoiceCommandKind =
  | 'disable'
  | 'mute'
  | 'unmute'
  | 'panic'
  | 'end_session';

export type VoiceCommand =
  | { kind: 'disable' }
  | { kind: 'mute' }
  | { kind: 'unmute' }
  | { kind: 'panic' }
  | { kind: 'end_session' };

export const ALL_VOICE_COMMAND_KINDS: ReadonlyArray<VoiceCommandKind> = [
  'disable',
  'mute',
  'unmute',
  'panic',
  'end_session',
];

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
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchVoiceCommand(text: string): VoiceCommand | null {
  if (!text) return null;
  const norm = normalize(text);
  if (!norm) return null;
  if (PANIC_RE.test(norm)) return { kind: 'panic' };
  if (END_SESSION_RE.test(norm)) return { kind: 'end_session' };
  if (MUTE_RE.test(norm)) return { kind: 'mute' };
  if (UNMUTE_RE.test(norm)) return { kind: 'unmute' };
  if (DISABLE_RE.test(norm)) return { kind: 'disable' };
  return null;
}
