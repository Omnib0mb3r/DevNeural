/* Haiku wiring (pillar 3 capstone).
 *
 * Thin flag-gated helpers the live voice WS calls. Each one is a pure
 * passthrough when DEVNEURAL_VOICE_HAIKU is OFF, so the current voice
 * path stays byte-identical: renderForSpeech is the identity, haikuRoute
 * returns null (the WS skips the haiku block entirely), and heartbeatLine
 * is the existing phrase. Keeping the flag logic here (not inline in the
 * 2000-line WS handler) makes "flag-off is unchanged" unit-testable.
 */
import { useVoiceHaiku } from './voice-haiku.js';
import { renderSpoken } from './voice-renderer.js';
import { frontDeskDecision, type FrontDeskDecision } from './voice-frontdesk.js';
import { composeHeartbeat } from './voice-heartbeat-haiku.js';
import { heartbeatPhrase } from './lex-voice-heartbeat.js';
import {
  generateGlueReply,
  glueModelAvailable,
  type GenerateGlueDeps,
  type GlueHint,
} from './voice-haiku-glue.js';

/* Spoken-output gate. OFF: the text is returned verbatim (the speak
 * controller's own cleanForTts then runs exactly as today). ON: route
 * through the renderer so numbers/decisions/negations survive verbatim
 * (V5). With no haiku model injected the renderer is the safe markdown
 * strip, which preserves all content. */
export function renderForSpeech(text: string): string {
  if (!useVoiceHaiku()) return text;
  return renderSpoken(text).spoken;
}

/* Inbound routing gate. OFF: null, so the WS runs its existing inject
 * path untouched. ON: the full front-desk decision (control -> glue ->
 * lane, persona prompt, digest freshness). */
export function haikuRoute(
  text: string,
  ctx: { lastTurnMs: number; assumeDigestFresh?: boolean },
): FrontDeskDecision | null {
  if (!useVoiceHaiku()) return null;
  return frontDeskDecision(text, ctx);
}

/* Heartbeat line. OFF: the existing duration-aware phrase, unchanged.
 * ON: the grounded persona-correct line (first-person Lex). */
export function heartbeatLine(elapsedMs: number): string {
  if (!useVoiceHaiku()) return heartbeatPhrase(elapsedMs);
  return composeHeartbeat({ lexElapsedMs: elapsedMs });
}

/* Fast-lane glue responder (haiku alone, zero Opus). BF-4 safe.
 *
 * Live path (DRIVE-QUEUE 1a): when the haiku tier owns the mouth AND a
 * key is configured, the warm/varied/in-persona reply comes from the LIVE
 * VOICE_HAIKU_MODEL grounded in the digest (generateGlueReply). The
 * deterministic lines below are the FALLBACK only - taken when no model /
 * key is available or the call misses - and are byte-identical to the
 * prior canned behavior, so flag-off and no-key paths do not change.
 *
 * Repeat / "say again" stays a deterministic VERBATIM replay of the last
 * spoken line: repeating must not be paraphrased (it would risk the V5
 * preserve-list). Only the empty-replay case (nothing said yet) and the
 * acks / delivery tweaks go to the live model.
 *
 * async: the live path awaits one short Haiku call - that IS the fast
 * lane (haiku alone). It is fail-fast; a miss returns the deterministic
 * line, never a hang. */
const REPEAT_RE =
  /^(say (that )?again|repeat( that)?|come again|what did you say|pardon|one more time|can you repeat( that)?)$/;

function deliveryHintOf(t: string): 'slower' | 'louder' | 'quieter' | null {
  if (/^(slower|speak slower|slow down)$/.test(t)) return 'slower';
  if (/^(louder|speak up|speak louder|a bit louder)$/.test(t)) return 'louder';
  if (/^(quieter|speak quieter)$/.test(t)) return 'quieter';
  return null;
}

export interface ComposeGlueDeps extends GenerateGlueDeps {
  /** Force the live model path on/off (tests). Default: flag on AND key
   * present. */
  modelEnabled?: boolean;
  generate?: typeof generateGlueReply;
}

export async function composeGlueReply(
  text: string,
  lastSpoken: string | null,
  deps?: ComposeGlueDeps,
): Promise<string | null> {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,]+$/, '');
  const delivery = deliveryHintOf(t);
  const modelEnabled =
    deps?.modelEnabled ?? (useVoiceHaiku() && glueModelAvailable());
  const generate = deps?.generate ?? generateGlueReply;
  const live = async (hint: GlueHint): Promise<string | null> => {
    if (!modelEnabled && !deps?.generate) return null;
    return generate({ utterance: text, hint }, deps);
  };

  if (REPEAT_RE.test(t)) {
    /* Verbatim replay of what was actually said; never the model. */
    if (lastSpoken && lastSpoken.trim()) return lastSpoken;
    return (await live('nothing-said')) ?? 'I had not said anything yet.';
  }

  const reply = await live(delivery ?? 'ack');
  if (reply) return reply;

  /* Deterministic fallback (byte-identical to the prior canned glue). */
  if (delivery === 'slower') return 'Slowing down.';
  if (delivery === 'louder') return 'Speaking up.';
  if (delivery === 'quieter') return 'Quieter.';
  /* Pure ack / yes-no: absorb, no spoken reply, no Lex round-trip. */
  return null;
}
