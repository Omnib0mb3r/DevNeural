/* Lex -> haiku digest (pillar 3, sliver V7; plan Hole 2).
 *
 * Lex owns ONE small live digest and pushes a fresh copy to haiku on
 * every turn boundary + state change. Haiku NEVER builds its own digest
 * from raw transcripts - that is exactly today's staleness bug
 * reincarnated at the mouth. Single source of truth: Lex is canonical,
 * haiku derives its fast-lane answers + heartbeat from this digest only.
 *
 * Fail-safe: a digest older than the last turn must NOT feed a fast-lane
 * answer. isDigestFresh gates that; the whitelist (V3) / lane router (V4)
 * already consume a digestFresh flag, and this is its source. Stale =
 * escalate (queue to Opus-Lex), never guess.
 */

export interface LexDigest {
  /** What Lex is working on right now. */
  currentTask: string;
  /** The most recent decision landed. */
  lastDecision: string;
  /** The open question / blocker, if any. */
  openQuestion: string;
  /** Grounded worker status (the worker is the only "he"). */
  workerStatus: string;
  /** Immediate next step(s). */
  nextSteps: string;
}

let current: { digest: LexDigest; ms: number } | null = null;

/* Derive a small live digest from Lex's already-synthesized user-facing
 * reply (DRIVE-QUEUE 1b). BF-4: the ONLY input is Lex's reply text, which
 * is synthesis destined for the user's ears, never raw brainstorm/project
 * content. The prior digest is carried forward so stable context
 * (currentTask / workerStatus / nextSteps) persists across turns while
 * lastDecision + openQuestion refresh from the newest reply. Haiku NEVER
 * builds this itself from transcripts; Lex pushes it and haiku reads it. */
export function buildVoiceDigest(
  replyText: string,
  prev?: LexDigest | null,
): LexDigest {
  const clean = replyText.replace(/\s+/g, ' ').trim();
  const firstSentence = (clean.match(/^[^.!?]*[.!?]/)?.[0] ?? clean)
    .trim()
    .slice(0, 200);
  const questions = clean.match(/[^.!?]*\?/g);
  const openQuestion =
    questions && questions.length > 0
      ? questions[questions.length - 1]!.trim().slice(0, 200)
      : (prev?.openQuestion ?? '');
  return {
    currentTask: prev?.currentTask ?? '',
    lastDecision: firstSentence,
    openQuestion,
    workerStatus: prev?.workerStatus ?? '',
    nextSteps: prev?.nextSteps ?? '',
  };
}

/** Lex pushes a fresh digest at a turn boundary / state change. */
export function pushDigest(digest: LexDigest, atMs: number): void {
  current = { digest, ms: atMs };
}

export function getDigest(): { digest: LexDigest; ms: number } | null {
  return current;
}

/* Fresh = a digest exists AND was pushed at or after the last turn
 * boundary. An older digest is stale: haiku must queue to Lex rather than
 * answer off it. */
export function isDigestFresh(lastTurnMs: number): boolean {
  return current !== null && current.ms >= lastTurnMs;
}

/** Test seam. */
export function _resetDigest(): void {
  current = null;
}
