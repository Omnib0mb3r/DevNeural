/**
 * Voice-command matcher for the panic button (PANIC-BUTTON.md step 6).
 *
 * Recognises the single trigger phrase "emergency stop" inside a
 * transcript line. Case-insensitive, punctuation-tolerant,
 * word-bounded so "emergency contact" does not false-fire. The
 * earlier broader set ("panic", "kill the worker") was dropped on
 * 2026-05-13 after six pty_not_found rows landed in panic_log from
 * voice misfires when the operator just said the word "panic"
 * mid-conversation. Tighter trigger means a real button press or
 * the explicit two-word phrase is required.
 *
 * Kept separate from lex-voice-ws so it can be unit-tested without
 * dragging in the audio bundle / WS pipeline.
 */
const PANIC_RE = /\bemergency\s+stop\b/;

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
