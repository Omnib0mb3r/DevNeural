/**
 * Voice-command matcher for the panic button.
 *
 * Recognises the single trigger phrase "lex emergency stop" inside a
 * transcript line. Case-insensitive, punctuation-tolerant,
 * word-bounded so "emergency contact" does not false-fire. The
 * earlier broader set ("panic", "kill the worker") was dropped on
 * 2026-05-13 after six pty_not_found rows landed in panic_log from
 * voice misfires when the operator just said the word "panic"
 * mid-conversation. On 2026-05-14 the trigger was further tightened
 * to require the "lex" prefix so meeting chatter that included the
 * raw phrase "emergency stop" can no longer fire the panic path
 * either; every Lex voice command shares the same prefix discipline.
 *
 * Kept separate from lex-voice-ws so it can be unit-tested without
 * dragging in the audio bundle / WS pipeline.
 */
const PANIC_RE = /\blex\s+emergency\s+stop\b/;

export function matchesPanicCommand(text: string): boolean {
  if (!text) return false;
  const norm = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return false;
  return PANIC_RE.test(norm);
}
