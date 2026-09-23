/**
 * Lex voice keyword matcher: panic only.
 *
 * 2026-07-15 voice-top-layer teardown (docs/archive/spec/
 * 2026-07-15-voice-top-layer-design.md). The old multi-command
 * keyword grammar (mute, unmute, standby, listen, disable,
 * end_session, hold_up, start_project) is gone. Those controls are
 * interpreted by Layer 1 (docs/spec/LAYER-1-CONTROL.md v3), which
 * emits CONTROL lines that fire the dispatch effects hub in
 * lex-voice-ws.ts; the client wake path is the other dispatch entry
 * point and accepts panic only. "lex emergency stop" stays as the ONE
 * mechanical keyword, checked before anything else, so the operator
 * can always halt the system even when the top layer is down. The
 * engine's stop class (stop, quiet, hold on) is the other deterministic
 * tier and lives in engine/interrupt-arbiter.ts.
 *
 * VoiceCommandKind is the effects hub's key set. The worker and
 * project effects (start, stop, interrupt the worker, switch project)
 * are Layer 1 verbs handled in applyTopLayerControl, not kinds here
 * (BUG-038; the old start_project kind was dead since the teardown).
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
  | 'hold_up';

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

/* v3 (2026-09-22 evening): the afternoon's fixed word gate for mute,
 * unmute, stand by, listen, end session and quiet is withdrawn. The
 * approved design (VOICE-BARGE-CLASSIFIER-SPEC section 2, operator
 * 2026-07-19) is that commands are AI-interpreted onto a closed verb set
 * and only the hard safety stop is a phrase. The reliability fix lives in
 * the Layer 1 contract (the CONTROL line is always the last line) and the
 * parser's narrated-verb inference. Panic stays the ONE mechanical
 * phrase. */
