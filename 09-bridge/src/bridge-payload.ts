/**
 * Bridge payload assembly helpers.
 *
 * Pure module (no vscode import) so the test suite can pin the
 * 2026-05-14-bridge-inject-missing-enter regression without spinning
 * a real VS Code instance.
 *
 * Background: the bridge used to call terminal.sendText twice for a
 * committed prompt -- once with the bracketed-paste-wrapped body, then
 * again with '\r' after an 80ms timeout. On a busy VS Code render
 * frame the second sendText occasionally raced ahead of the first
 * call's PTY-write flush, so the trailing '\r' landed inside the
 * bracketed-paste envelope and Claude Code's TUI treated it as part
 * of the pasted text instead of as Enter. Symptom from the bug doc:
 * "Worker session 9c4f80a8 sat with the text visible in its input
 * field for ~52 minutes until the user manually pressed Enter."
 *
 * The fix is to assemble body + '\r' in a single string and hand it
 * to terminal.sendText as one call. The integrated terminal commits
 * the underlying PTY write atomically, so by the time '\r' arrives
 * at the TUI the \x1b[201~ paste terminator has already closed the
 * envelope.
 */

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const BRACKETED_PASTE_THRESHOLD = 200;

export function needsBracketedPaste(text: string): boolean {
  return text.includes('\n') || text.length > BRACKETED_PASTE_THRESHOLD;
}

export function wrapBracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/* Build the exact byte sequence the bridge hands to terminal.sendText
 * in a single atomic call. commit=true appends '\r' AFTER the body
 * (which may already be bracketed-paste-wrapped). commit=false ships
 * the body alone so the user can review / edit before submitting. */
export function buildBridgePayload(text: string, commit: boolean): string {
  const body = needsBracketedPaste(text) ? wrapBracketedPaste(text) : text;
  return commit ? `${body}\r` : body;
}

export {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_THRESHOLD,
};
