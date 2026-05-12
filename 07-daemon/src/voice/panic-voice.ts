/**
 * Voice-command matcher for the panic button (PANIC-BUTTON.md step 6).
 *
 * Recognises the three trigger phrases from the spec
 * ("panic", "emergency stop", "kill the worker") inside a transcript
 * line. Case-insensitive, punctuation-tolerant, word-bounded so
 * "panicked" / "emergency contact" / "work less" do not false-fire.
 *
 * Kept separate from lex-voice-ws so it can be unit-tested without
 * dragging in the audio bundle / WS pipeline.
 */
const PANIC_RE =
  /\b(?:panic|emergency\s+stop|kill\s+the\s+worker)\b/;

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
