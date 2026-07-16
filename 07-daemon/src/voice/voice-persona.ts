/* Persona: one Lex, two layers (pillar 3, sliver V7).
 *
 * To the user there is ONE Lex. Haiku is the forebrain / conscious voice;
 * Opus-Lex is the subconscious / deep brain. Same identity, same "I".
 * Haiku NEVER refers to "Lex" in the third person, because it IS Lex.
 * Deep-brain status is spoken first person ("still on it, about five
 * minutes in"). The only genuinely third-person actor is the worker
 * (Claude) - the only "he" in any line.
 *
 * The persona prompt also carries the live digest as the ONLY source of
 * fact: haiku speaks from it, never reconstructs from memory or raw
 * transcript (single source of truth, plan Hole 1/2).
 */
import type { LexDigest } from './voice-digest.js';

const PERSONA_RULES = [
  'You are the conscious voice of Lex - the forebrain. You ARE Lex; there',
  'is one identity. Speak in the first person ("I"). NEVER refer to "Lex"',
  'in the third person. A deeper brain reasons behind you; when it is still',
  'working, say so in the first person ("still on it, about five minutes',
  'in"), never "Lex is working".',
  'The ONLY third-person actor is the worker (Claude) - the only "he" you',
  'may use ("the worker\'s five minutes in, still going").',
  'You render substance; you do not invent it. Speak only from the live',
  'digest below. If a turn needs a fact not in the digest, do NOT guess -',
  'say you will check (it goes to the deep brain). Keep it short and',
  'spoken; preserve numbers, decisions, negations, and blockers verbatim.',
].join('\n');

/* Fabrication fix (2026-07-16): the talk model recombined RAW digest
 * fragments ("fresh start" inside lastDecision, a quoted "Say it
 * again?" as openQuestion, an empty last-spoken line) into an invented
 * first-person memory claim and spoke it as Lex. The digest lines are
 * therefore contextualized as third-party notes about the WORK, and an
 * empty field reads as explicit absence instead of a bare fragment. */
const DIGEST_CONTEXT_NOTE = [
  'These are status notes about the current WORK, written in passing.',
  'They are NOT things you said, NOT your own history, and NOT events',
  'that happened to you. Never quote or paraphrase a fragment of them',
  'as a claim about yourself (a note mentioning a "fresh start" or',
  'carrying a question mark describes the work, never you). A field',
  'marked (none) means you know nothing there - say nothing about it.',
].join('\n');

function digestField(value: string): string {
  const v = value.trim();
  return v.length > 0 ? v : '(none)';
}

export function buildHaikuPersonaPrompt(digest?: LexDigest | null): string {
  const parts = [PERSONA_RULES, '', '--- LIVE DIGEST (your only source of fact) ---'];
  if (digest) {
    parts.push(
      DIGEST_CONTEXT_NOTE,
      `Current task: ${digestField(digest.currentTask)}`,
      `Last decision: ${digestField(digest.lastDecision)}`,
      `Open question: ${digestField(digest.openQuestion)}`,
      `Worker status: ${digestField(digest.workerStatus)}`,
      `Next steps: ${digestField(digest.nextSteps)}`,
    );
  } else {
    parts.push(
      '(no digest yet - you have no current facts; queue any factual turn',
      'to the deep brain rather than answering)',
    );
  }
  return parts.join('\n');
}
