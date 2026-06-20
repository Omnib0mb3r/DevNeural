/* Deny-by-default whitelist (pillar 3.3, sliver V3).
 *
 * The haiku front desk's default action for any turn is QUEUE for Lex.
 * Only a tiny whitelist of pure conversational glue may be answered by
 * haiku alone. The teachable line: haiku may only talk about the
 * conversation itself. The instant a turn needs any fact about the
 * project, code, state, or history, it queues to Opus-Lex and never
 * answers. When unsure, queue.
 *
 * Glue = acknowledgments, "say that again" / repeat-last-line, delivery
 * tweaks (slower / louder), and yes/no about what was just said. The
 * whole utterance must be glue (full match), so "yeah, and what about the
 * schema" queues - it is not a bare ack.
 *
 * V7 fail-safe (Hole 2): if Lex's pushed digest is stale (older than the
 * last turn), even a glue turn downgrades to queue - a stale digest must
 * never feed a fast-lane answer. Pass digestFresh=false to force queue.
 *
 * Pure classifier; the lane router (V4) calls the control channel first,
 * then this.
 */

export type TurnClass = 'handle' | 'queue';

export interface WhitelistDecision {
  class: TurnClass;
  reason: string;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,]+$/, '');
}

/* Exact-match glue phrases (the whole utterance must be one of these). */
const GLUE_PHRASES = new Set<string>([
  // acknowledgments
  'ok', 'okay', 'k', 'kk', 'cool', 'nice', 'great', 'awesome', 'perfect',
  'thanks', 'thank you', 'ty', 'got it', 'gotcha', 'sounds good',
  'makes sense', 'fair', 'fair enough', 'sure', 'alright', 'all right',
  'good', 'good job', 'well done', 'nevermind', 'never mind',
  // yes/no about the last line
  'yes', 'yeah', 'yep', 'yup', 'no', 'nope', 'nah', 'right', 'correct',
  'exactly', 'agreed', 'mhm', 'uh huh',
  // delivery tweaks (not control: keep talking, just adjust)
  'slower', 'speak slower', 'slow down', 'louder', 'speak up',
  'a bit louder', 'speak louder', 'quieter', 'speak quieter',
]);

/* Repeat / say-again variants. */
const REPEAT_RE =
  /^(say (that )?again|repeat( that)?|come again|what did you say|pardon|sorry,? what|one more time|can you repeat( that)?)$/;

export function classifyTurn(
  text: string,
  opts?: { digestFresh?: boolean },
): WhitelistDecision {
  const t = norm(text);
  if (!t) return { class: 'queue', reason: 'empty' };

  const isGlue = GLUE_PHRASES.has(t) || REPEAT_RE.test(t);
  if (!isGlue) {
    /* Anything that is not pure glue is, by construction, a turn that
     * may need a project/code/state fact. Deny by default. */
    return { class: 'queue', reason: 'not-glue (deny-by-default)' };
  }
  /* V7 fail-safe: a glue turn still queues when the digest is stale, so
   * haiku never answers off a digest older than the last turn. */
  if (opts?.digestFresh === false) {
    return { class: 'queue', reason: 'glue-but-digest-stale' };
  }
  return { class: 'handle', reason: 'conversational-glue' };
}
