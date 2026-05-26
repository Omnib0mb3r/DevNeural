/**
 * Coalesce-utterance-queue helpers (Fix 35 Phase A, 2026-05-26).
 *
 * Pure utilities for the sealed coalesce contract (full spec at
 * docs/spec/COALESCE-UTTERANCE-QUEUE.md). This module owns three
 * concerns deliberately separated from the WS state machine:
 *
 *   1. Format a queued-utterance batch into a single combined
 *      payload Lex sees as one structured turn.
 *   2. Detect "contradiction" patterns (cancel / never mind / forget
 *      it) so the WS state machine can short-circuit the queue and
 *      ack the cancel instead of replaying the original request.
 *
 * The WS file orchestrates state, this file owns the rules. Keeps
 * both testable without standing up a real socket.
 */

export interface DrainBatch {
  /** Single combined payload to inject to Lex as one user turn. */
  text: string;
  /** Number of original utterances that landed in this batch.
   * Surfaced in the WS `t:'injected'` frame for client telemetry. */
  count: number;
}

/* Drain a pending-utterance queue into one structured payload. The
 * head/list shape mirrors the cc-pty mid-turn flush header
 * (lex-voice-ws.ts:447) so the system-prompt rule that recognises
 * the [voice-context] marker stays in one place. */
export function formatQueueDrain(queued: readonly string[]): DrainBatch | null {
  if (queued.length === 0) return null;
  if (queued.length === 1) {
    return { text: queued[0]!, count: 1 };
  }
  const header =
    `[voice-context: queued-utterances (${queued.length})] ` +
    `The user spoke these in sequence while you were replying. ` +
    `Compose ONE reply addressing all of them; if the latest contradicts ` +
    `the earlier ones, treat the latest as the cancellation and ack briefly:`;
  const body = queued.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return { text: `${header}\n\n${body}`, count: queued.length };
}

/* Per the sealed contract (point 5, contradiction case): "user
 * countermands original instruction; latest wins. Stop work, ack the
 * cancel, drop the original, do not double-reply."
 *
 * Detected via a small lexicon of cancel-intent phrases. Broad on
 * purpose; the gate is "we are currently mid-reply" — these phrases
 * only contradict when there is something to contradict. The voice
 * path also has the `lex hold up` wake-command for explicit barge;
 * this catches the same intent when said without the "lex" prefix.
 *
 * Patterns are word-bounded so e.g. "stopwatch" or "cancellation" in
 * a normal sentence does not false-fire. */
const CONTRADICTION_PATTERNS: readonly RegExp[] = [
  /\bcancel(?:\s+(?:it|that|this))?\b/i,
  /\bnever\s*mind\b/i,
  /\bforget\s+(?:it|that|this)\b/i,
  /\b(?:stop|halt|abort)\s+(?:it|that|this|now|please)\b/i,
  /\bdrop\s+(?:it|that|this)\b/i,
  /\bhold\s+(?:up|on)\b/i,
];

export function detectContradiction(text: string): boolean {
  if (!text) return false;
  for (const re of CONTRADICTION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}
