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

/* Fast-lane glue responder (haiku alone, zero Opus). Deterministic, BF-4
 * safe: repeat replays the last spoken line; delivery tweaks ack; bare
 * acknowledgments are absorbed silently (null = nothing spoken, nothing
 * queued). A live haiku model can replace this for richer phrasing once
 * the BF-4 posture for the voice layer is settled. */
const REPEAT_RE =
  /^(say (that )?again|repeat( that)?|come again|what did you say|pardon|one more time|can you repeat( that)?)$/;

export function composeGlueReply(
  text: string,
  lastSpoken: string | null,
): string | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,]+$/, '');
  if (REPEAT_RE.test(t)) {
    return lastSpoken && lastSpoken.trim()
      ? lastSpoken
      : 'I had not said anything yet.';
  }
  if (/^(slower|speak slower|slow down)$/.test(t)) return 'Slowing down.';
  if (/^(louder|speak up|speak louder|a bit louder)$/.test(t)) {
    return 'Speaking up.';
  }
  if (/^(quieter|speak quieter)$/.test(t)) return 'Quieter.';
  /* Pure ack / yes-no: absorb, no spoken reply, no Lex round-trip. */
  return null;
}
