/**
 * Lex voice keyword matcher: panic only.
 *
 * 2026-07-15 voice-top-layer teardown (docs/superpowers/specs/
 * 2026-07-15-voice-top-layer-design.md). The old multi-command
 * keyword grammar (mute, unmute, standby, listen, disable,
 * end_session, hold_up, start_project) is gone. Those controls are
 * now interpreted by the voice top layer, which emits CONTROL lines
 * that fire the dispatch effects hub in lex-voice-ws.ts; the client
 * wake path is the other dispatch entry point. "lex emergency stop"
 * stays as the ONE mechanical keyword, checked before anything else,
 * so the operator can always halt the system even when the top layer
 * is down.
 *
 * VoiceCommandKind and ALL_VOICE_COMMAND_KINDS keep the full kind
 * set: the effects hub keys its effects (and the wake-frame kind
 * guard) on every kind, even though only panic is matched here.
 *
 * The lex-voice WS normalises whisper output to lower-cased,
 * punctuation-stripped, whitespace-collapsed text before reaching
 * this matcher; the normalize step is reproduced here so the
 * standalone function can be unit-tested on raw user input.
 */

export type VoiceCommandKind =
  | 'disable'
  | 'mute'
  | 'unmute'
  | 'panic'
  | 'end_session'
  | 'standby'
  | 'listen'
  | 'hold_up'
  | 'start_project';

export const ALL_VOICE_COMMAND_KINDS: ReadonlyArray<VoiceCommandKind> = [
  'disable',
  'mute',
  'unmute',
  'panic',
  'end_session',
  'standby',
  'listen',
  'hold_up',
  'start_project',
];

const LEX_PREFIX = String.raw`\blex\s+`;

const PANIC_RE = new RegExp(LEX_PREFIX + String.raw`emergency\s+stop\b`);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True only for the panic phrase "lex emergency stop". Every other
 * utterance is a top-layer concern and must return false here.
 */
export function matchPanicCommand(text: string): boolean {
  if (!text) return false;
  const norm = normalize(text);
  if (!norm) return false;
  return PANIC_RE.test(norm);
}
