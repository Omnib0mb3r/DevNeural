/* Live haiku glue generation (pillar 3, DRIVE-QUEUE 1a).
 *
 * The voice fast lane used to answer conversational glue (acks, delivery
 * tweaks, "say again") with hardcoded strings ("Slowing down.", etc).
 * They read cold and robotic. This module replaces them with a live
 * VOICE_HAIKU_MODEL call in Lex's persona, grounded in the live digest,
 * so the quick replies are warm, varied, and continuous with the moment.
 *
 * BF-4 boundary (preserved): the model only ever sees (a) the user's
 * conversational aside and (b) the persona prompt, which carries ONLY
 * Lex's already-synthesized live digest. It never sees raw brainstorm /
 * project content. The digest is Lex-canonical synthesis, not transcript.
 *
 * Latency posture: this runs on the fast lane (haiku alone, zero Opus),
 * so one short Haiku call is the design, not a regression. The call is
 * fail-fast (no retries, tight timeout); any miss falls back to the
 * deterministic glue in voice-haiku-wiring, so a missing key or a slow
 * network never breaks or hangs the lane.
 *
 * Variation: a small ring of recent replies is fed back into the prompt
 * as an avoid-list, and an exact repeat of the immediately-previous line
 * is rejected, so the same aside never reads the same way twice.
 */
import Anthropic from '@anthropic-ai/sdk';
import { VOICE_HAIKU_MODEL, voiceApiKey } from './voice-haiku.js';
import { getDigest } from './voice-digest.js';
import { buildHaikuPersonaPrompt } from './voice-persona.js';

/** Delivery-tweak hint the fast lane already classified, plus the two
 * non-tweak glue shapes (a bare ack, or a repeat with nothing said yet). */
export type GlueHint = 'slower' | 'louder' | 'quieter' | 'ack' | 'nothing-said';

/* One short spoken sentence; a tight ceiling keeps the lane fast. */
const VOICE_GLUE_MAX_TOKENS = 48;
/* Variation, not facts: glue is non-factual, so a warm temperature is
 * safe and is what kills the robotic sameness. */
const VOICE_GLUE_TEMPERATURE = 0.9;
/* Fail-fast ceiling. Past this we drop to the deterministic line rather
 * than make the operator wait on the fast lane. */
const VOICE_GLUE_TIMEOUT_MS = Number(
  process.env.DEVNEURAL_VOICE_GLUE_TIMEOUT_MS ?? 2500,
);

export interface GlueModelInput {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}
/** Injectable model seam: returns the reply text, or null on
 * empty/unavailable. Tests pass a fake; production uses the SDK. */
export type GlueModelCall = (input: GlueModelInput) => Promise<string | null>;

let client: Anthropic | null = null;

const defaultCall: GlueModelCall = async ({
  system,
  user,
  maxTokens,
  temperature,
}) => {
  const apiKey = voiceApiKey();
  if (!apiKey) return null;
  if (!client) {
    /* No SDK auto-retries: on the voice lane a retry is worse than the
     * deterministic fallback. */
    client = new Anthropic({ apiKey, maxRetries: 0 });
  }
  const resp = await client.messages.create(
    {
      model: VOICE_HAIKU_MODEL,
      max_tokens: maxTokens,
      temperature,
      system: [{ type: 'text' as const, text: system }],
      messages: [{ role: 'user' as const, content: user }],
    },
    { timeout: VOICE_GLUE_TIMEOUT_MS },
  );
  const text = resp.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  return text || null;
};

/** True when a live glue call can be made (a voice API key is present -
 * ANTHROPIC_API_KEY or the BRIDGER fallback). */
export function glueModelAvailable(): boolean {
  return Boolean(voiceApiKey());
}

/* Recent spoken glue lines, newest last. Fed back as an avoid-list and
 * used to reject an exact immediate repeat. */
const recent: string[] = [];
const RECENT_MAX = 8;
function remember(line: string): void {
  recent.push(line);
  while (recent.length > RECENT_MAX) recent.shift();
}

/** Test seam: clear the variation ring. */
export function _resetGlueHistory(): void {
  recent.length = 0;
}

function hintLine(hint: GlueHint): string {
  switch (hint) {
    case 'slower':
      return 'The user asked you to slow down; acknowledge it in passing, in your own words.';
    case 'louder':
      return 'The user asked you to speak up; acknowledge it in passing, in your own words.';
    case 'quieter':
      return 'The user asked you to be quieter; acknowledge it in passing, in your own words.';
    case 'nothing-said':
      return 'The user asked you to repeat yourself, but you have not said anything yet; say so warmly.';
    case 'ack':
    default:
      return 'The user gave a short acknowledgment or yes/no about what was just said.';
  }
}

function glueInstruction(hint: GlueHint): string {
  const lines = [
    '--- VOICE FAST LANE (you are speaking out loud, right now) ---',
    hintLine(hint),
    'Reply in ONE short spoken sentence, warm and natural, in your own',
    'voice. Vary your phrasing every time; never reuse a line you have',
    'used before. You may nod to the current moment using the digest, but',
    'do NOT volunteer new facts and do NOT answer questions here - this is',
    'just conversational glue. If no reply is warranted (a bare "ok" that',
    'needs nothing back), output exactly the token <none>.',
  ];
  if (recent.length > 0) {
    lines.push('Avoid repeating any of these recent lines:');
    for (const r of recent) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}

export interface GenerateGlueDeps {
  call?: GlueModelCall;
  /** Override the persona prompt (tests). Default: built from the live
   * digest singleton, BF-4 safe. */
  personaPrompt?: string;
}

/* Generate one warm, varied, in-persona glue reply. Returns null to mean
 * "absorb silently" (the model emitted <none>) or "unavailable / failed"
 * (caller then uses the deterministic fallback). */
export async function generateGlueReply(
  input: { utterance: string; hint: GlueHint },
  deps?: GenerateGlueDeps,
): Promise<string | null> {
  const call = deps?.call ?? defaultCall;
  const persona =
    deps?.personaPrompt ??
    buildHaikuPersonaPrompt(getDigest()?.digest ?? null);
  const system = `${persona}\n\n${glueInstruction(input.hint)}`;

  let out: string | null;
  try {
    out = await call({
      system,
      user: input.utterance,
      maxTokens: VOICE_GLUE_MAX_TOKENS,
      temperature: VOICE_GLUE_TEMPERATURE,
    });
  } catch {
    /* Network / timeout / SDK error: defer to the deterministic line. */
    return null;
  }
  if (!out) return null;
  const cleaned = out.trim();
  if (!cleaned || /^<none>\.?$/i.test(cleaned)) return null;
  /* Hard guard on the never-twice promise: an exact repeat of the line
   * we just spoke falls back rather than echoing. */
  if (recent.length > 0 && recent[recent.length - 1] === cleaned) {
    return null;
  }
  remember(cleaned);
  return cleaned;
}

/* Bridge instruction (DRIVE-QUEUE, slow-lane filler). The user asked
 * something that needs Lex to actually look (a project / code / state /
 * history question); Lex is about to reason on it. This produces the
 * INSTANT spoken line that fills the gap - the "let me look" slot - but
 * specific to what they actually asked instead of a canned filler. */
function bridgeInstruction(): string {
  const lines = [
    '--- VOICE FAST LANE: BRIDGE (you are speaking out loud, right now) ---',
    'The user just asked something that needs you to actually look or',
    'think - a project, code, state, or history question - and you are',
    'about to go find the answer. Say ONE short, natural spoken line, in',
    'your own voice, that acknowledges THEIR SPECIFIC request and signals',
    'you are on it right now. Make it specific to what they asked (lean on',
    'the digest for the topic when it helps); vary your phrasing every',
    'time. Do NOT answer the question yet and do NOT invent facts - this',
    'is only the bridge before you reason. Never reuse a line you have',
    'used before.',
  ];
  if (recent.length > 0) {
    lines.push('Avoid repeating any of these recent lines:');
    for (const r of recent) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}

/* Generate one warm, specific, in-persona BRIDGE line for the slow lane.
 * Returns null on unavailable/failed/empty (caller uses the deterministic
 * bridge). Shares the never-twice ring with the glue path so a bridge and
 * an ack never read the same back-to-back. */
export async function generateBridgeReply(
  input: { utterance: string },
  deps?: GenerateGlueDeps,
): Promise<string | null> {
  const call = deps?.call ?? defaultCall;
  const persona =
    deps?.personaPrompt ??
    buildHaikuPersonaPrompt(getDigest()?.digest ?? null);
  const system = `${persona}\n\n${bridgeInstruction()}`;
  let out: string | null;
  try {
    out = await call({
      system,
      user: input.utterance,
      maxTokens: VOICE_GLUE_MAX_TOKENS,
      temperature: VOICE_GLUE_TEMPERATURE,
    });
  } catch {
    return null;
  }
  const cleaned = (out ?? '').trim();
  if (!cleaned || /^<none>\.?$/i.test(cleaned)) return null;
  if (recent.length > 0 && recent[recent.length - 1] === cleaned) return null;
  remember(cleaned);
  return cleaned;
}

/* Live-haiku RENDER of Lex's already-synthesized reply body (DRIVE-QUEUE
 * 1b). Restyles for warm spoken delivery; the verbatim guard lives in
 * renderSpokenAsync, which rejects any candidate that drops a preserve
 * span and ships the safe render instead. Lower temperature than glue:
 * render is faithful restyling, not free invention.
 *
 * BF-4 (preserved): the only inputs are the persona prompt (which carries
 * ONLY Lex's synthesized digest) + Lex's reply body. No raw content. */
const VOICE_RENDER_TEMPERATURE = 0.4;
/* DRIVE-QUEUE 1c truncation fix: the cap must never CUT a long reply.
 * Size max_tokens to the input so the model is not told to stop mid-
 * reply (a fixed 512 cut long replies off mid-sentence, the "cuts off /
 * like a timeout" symptom). A spoken restyle is roughly the same length
 * as the input or shorter; ~chars/4 tokens + a generous margin covers
 * it. Bounded so a runaway input cannot request an unbounded generation;
 * past the ceiling the render simply times out and the full safe render
 * ships (still complete, never truncated). */
const VOICE_RENDER_MIN_TOKENS = 96;
const VOICE_RENDER_MAX_TOKENS_CEIL = 2048;
/* Below this input length truncation is not a risk, so a restyle that
 * does not end on a sentence boundary is accepted as-is (a short reply
 * may legitimately have no terminal punctuation). At/above it, an
 * unterminated restyle is treated as a cut and the full safe render is
 * shipped instead. */
const VOICE_RENDER_COMPLETENESS_MIN_CHARS = 280;

function renderMaxTokens(text: string): number {
  const est = Math.round((Math.ceil(text.length / 4) + 64) * 1.3);
  return Math.max(
    VOICE_RENDER_MIN_TOKENS,
    Math.min(VOICE_RENDER_MAX_TOKENS_CEIL, est),
  );
}

/* A complete restyle of a complete reply ends on a sentence boundary.
 * One that does not (and whose input was long enough for truncation to
 * matter) was cut by the token cap / an early stop; ship nothing so the
 * caller falls back to the FULL safe render rather than speak a sentence
 * that never finishes. */
function looksTruncated(input: string, out: string): boolean {
  if (input.trim().length < VOICE_RENDER_COMPLETENESS_MIN_CHARS) return false;
  return !/[.!?"'’)\]]\s*$/.test(out);
}

function renderInstruction(preserve: string[]): string {
  const lines = [
    '--- SPOKEN RENDER (you are about to say this out loud) ---',
    'Restyle the message below into warm, natural spoken delivery in your',
    'own voice: drop markdown, smooth the connective prose. You are a',
    'renderer, not a re-thinker - say ALL of it, do not summarize, omit,',
    'or cut it short; do not add facts, opinions, or questions, and do not',
    'change meaning. Output ONLY the spoken text, in full.',
  ];
  if (preserve.length > 0) {
    lines.push(
      'You MUST keep these exact spans verbatim (numbers, ids, and',
      'negations must survive unchanged):',
    );
    for (const p of preserve) lines.push(`- ${p}`);
  }
  return lines.join('\n');
}

export interface RenderReplyDeps {
  call?: GlueModelCall;
  personaPrompt?: string;
}

/* Returns the restyled spoken text, or '' on unavailable/empty (the
 * caller's renderSpokenAsync then ships the safe render). */
export async function renderReplyLive(
  text: string,
  preserve: string[],
  deps?: RenderReplyDeps,
): Promise<string> {
  const call = deps?.call ?? defaultCall;
  const persona =
    deps?.personaPrompt ??
    buildHaikuPersonaPrompt(getDigest()?.digest ?? null);
  const system = `${persona}\n\n${renderInstruction(preserve)}`;
  let out: string | null;
  try {
    out = await call({
      system,
      user: text,
      maxTokens: renderMaxTokens(text),
      temperature: VOICE_RENDER_TEMPERATURE,
    });
  } catch {
    return '';
  }
  const trimmed = (out ?? '').trim();
  if (!trimmed) return '';
  /* Truncation backstop: never speak a long reply that was cut short.
   * If it does not end on a sentence boundary, fall back to the full
   * safe render. */
  if (looksTruncated(text, trimmed)) return '';
  return trimmed;
}
