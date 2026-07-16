/* Never-twice spoken-line ring (all that survives of the metered glue
 * module, spec v2 teardown 2026-07-15).
 *
 * This file used to carry the metered Anthropic SDK glue/bridge
 * generators (deprecated 2026-07-15 when the persistent session took
 * over small talk) and the live-haiku reply restyle (removed in spec
 * v2: it cost a full LLM round trip before Lex's reply reached piper).
 * What remains is the shared variation ring: the voice top layer
 * checks it so a conversational reply is never the same line twice in
 * a row, no matter which path produced the line.
 */

/* Recent spoken lines, newest last. Used to reject an exact immediate
 * repeat. */
const recent: string[] = [];
const RECENT_MAX = 8;

/** Test seam: clear the variation ring. */
export function _resetGlueHistory(): void {
  recent.length = 0;
}

/** True when `line` is the immediately-previous spoken line. */
export function wasLastSpoken(line: string): boolean {
  return recent.length > 0 && recent[recent.length - 1] === line;
}

/** Register a spoken line in the shared ring (see wasLastSpoken). */
export function rememberSpokenLine(line: string): void {
  recent.push(line);
  while (recent.length > RECENT_MAX) recent.shift();
}
