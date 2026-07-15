/* Haiku wiring (pillar 3 capstone).
 *
 * Thin flag-gated helpers the live voice WS calls. Each one is a pure
 * passthrough when DEVNEURAL_VOICE_HAIKU is OFF, so the current voice
 * path stays byte-identical: renderForSpeech is the identity, haikuRoute
 * returns null (the WS skips the haiku block entirely), and heartbeatLine
 * is the existing phrase. Keeping the flag logic here (not inline in the
 * 2000-line WS handler) makes "flag-off is unchanged" unit-testable.
 */
import { useVoiceHaiku, daypartOf, type Daypart } from './voice-haiku.js';
import { renderSpoken, renderSpokenAsync } from './voice-renderer.js';
import { frontDeskDecision, type FrontDeskDecision } from './voice-frontdesk.js';
import { composeHeartbeat } from './voice-heartbeat-haiku.js';
import { heartbeatPhrase } from './lex-voice-heartbeat.js';
import {
  generateGlueReply,
  generateBridgeReply,
  glueModelAvailable,
  renderReplyLive,
  wasLastSpoken,
  rememberSpokenLine,
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

export interface RenderReplyForSpeechDeps {
  /** Injected live render (tests). Default: renderReplyLive. */
  render?: (text: string, preserve: string[]) => Promise<string>;
  /** Force the live-model path on/off (tests). Default: key present. */
  modelEnabled?: boolean;
}

/* LIVE-haiku render of Lex's reply body for warm spoken delivery
 * (DRIVE-QUEUE 1b). Flag OFF: identity (byte-identical - the WS skips the
 * haiku block anyway). Flag ON + key: route through renderSpokenAsync
 * with the live model, verbatim-guarded (a paraphrase that drops a
 * number/decision/negation is rejected for the safe render). Flag ON, no
 * key: the safe markdown-strip render, exactly as renderForSpeech does
 * today. Async; the live call is the only added latency and only on the
 * reply body, never on acks/glue/heartbeats. */
export async function renderReplyForSpeech(
  text: string,
  deps?: RenderReplyForSpeechDeps,
): Promise<string> {
  if (!useVoiceHaiku()) return text;
  const modelEnabled = deps?.modelEnabled ?? glueModelAvailable();
  const render = deps?.render ?? renderReplyLive;
  if (!modelEnabled && !deps?.render) {
    return renderSpoken(text).spoken;
  }
  const res = await renderSpokenAsync(text, {
    haikuRender: (t, preserve) => render(t, preserve),
  });
  return res.spoken;
}

/* Inbound routing gate. OFF: null, so the WS runs its existing inject
 * path untouched. ON: the full front-desk decision (control -> glue ->
 * lane, persona prompt, digest freshness).
 *
 * Greeting override (2026-07-14, requirements 3 + 4): the deny-by-default
 * whitelist (voice-whitelist.ts, out of this module's scope) has no
 * notion of greetings, so "good morning" etc. always fell out of its
 * not-glue branch and queued to Lex - digest fresh or not, cold start or
 * not - landing a generic bridge filler instead of an actual answer. A
 * greeting never needs a project/code/state fact (it is answered from the
 * local clock, not the digest), so once the utterance matches the local
 * greeting detector, this downgrades a 'slow' route to 'fast' regardless
 * of digest freshness - including the digest-absent cold-start case
 * (requirement 4). Anything that is NOT a greeting keeps going through
 * frontDeskDecision's existing staleness gate untouched. */
export function haikuRoute(
  text: string,
  ctx: { lastTurnMs: number; assumeDigestFresh?: boolean },
): FrontDeskDecision | null {
  if (!useVoiceHaiku()) return null;
  const dec = frontDeskDecision(text, ctx);
  if (dec.route.lane === 'slow' && isGreetingAside(text)) {
    return {
      ...dec,
      route: { lane: 'fast', reason: 'greeting-answered-locally' },
    };
  }
  return dec;
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

/* Time-aware greeting handling (2026-07-14). Operator complaint: "good
 * morning" / "good afternoon" landed a canned "on it" or a bridge filler
 * ("checking now") because greetings were not in the deny-by-default
 * whitelist at all - they always queued to Lex, digest-fresh or not, cold
 * start or not. Fixed here (owned files only): a small whole-utterance
 * greeting matcher, a route override so a greeting always answers on the
 * fast lane (see haikuRoute below), and a deterministic time-aware canned
 * pool so even a no-key / call-miss reply is never a bare "on it". */

export type GreetingClaim = 'morning' | 'afternoon' | 'evening' | 'generic';

/* Whole-utterance match, same normalized-full-match convention as
 * deliveryHintOf/REPEAT_RE above and the deny-by-default whitelist ("yeah,
 * and what about the schema" is not glue; "good morning" alone is).
 * 'morning' / 'afternoon' / 'evening' carry a claim about the time of day
 * that gets checked against the real daypart below; 'generic' (hello/hi/
 * hey/...) makes no claim, so it always gets the plain daypart line. */
function greetingClaimOf(t: string): GreetingClaim | null {
  if (/^(good morning|morning|mornin)$/.test(t)) return 'morning';
  if (/^(good afternoon|afternoon)$/.test(t)) return 'afternoon';
  if (/^(good evening|evening)$/.test(t)) return 'evening';
  if (/^(hello|hi|hey|hey lex|hiya|yo|howdy)$/.test(t)) return 'generic';
  return null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,]+$/, '');
}

/** True when the whole (normalized) utterance is a greeting. Exported for
 * the route override (haikuRoute) and for tests. */
export function isGreetingAside(text: string): boolean {
  return greetingClaimOf(normalize(text)) !== null;
}

/* Does the claimed time of day cover the real daypart? 'morning' spans
 * both early-morning and morning (nobody minds "good morning" at 6:30);
 * afternoon/evening are exact. Anything not covered - including every
 * specific claim during 'late night' - is a mismatch and gets the light
 * correction pool instead of the plain one. */
function claimMatchesDaypart(claim: GreetingClaim, daypart: Daypart): boolean {
  if (claim === 'generic') return true;
  if (claim === 'morning') return daypart === 'early morning' || daypart === 'morning';
  return claim === daypart;
}

/* Plain daypart-correct greeting. Two natural, warm, contraction-friendly
 * variants per daypart - short spoken lines, no name-tacking, no robotic
 * fragments. */
const GREETING_LINES: Record<Daypart, [string, string]> = {
  'early morning': ["You're up early - good morning.", 'Morning. Early start today.'],
  morning: ['Good morning.', 'Morning.'],
  afternoon: ['Good afternoon.', 'Afternoon.'],
  evening: ['Good evening.', 'Evening.'],
  'late night': ["Hey - it's late, but good to hear from you.", 'Still up. Hi.'],
};

/* Light correction when the greeting's claimed time of day does not match
 * the real one (e.g. "good morning" said at 2am). States the real daypart
 * without mirroring the wrong word back. */
const GREETING_CORRECTION_LINES: Record<Daypart, [string, string]> = {
  'early morning': ["It's actually early morning here, still dark out - but hey.", 'Early morning on my end - hi.'],
  morning: ["It's morning here too, just later than that sounded - hey.", 'Morning here as well.'],
  afternoon: ["It's actually afternoon here - but good to hear from you.", 'Afternoon on my end - hey.'],
  evening: ["It's evening here, not that - good to hear from you though.", 'Evening on my end - hi.'],
  'late night': ["It's actually the middle of the night here - but good to hear from you.", 'Pretty late on my end, still around though.'],
};

/* Deterministic time-aware canned greeting (requirement 3/4 fallback).
 * Shares the live-model never-twice ring (voice-haiku-glue.ts) so a
 * canned pick and a live pick never read the same back-to-back, and the
 * pool itself still alternates call over call instead of freezing on its
 * first candidate. */
function cannedGreeting(claim: GreetingClaim, now: Date): string {
  const daypart = daypartOf(now.getHours());
  const pool = claimMatchesDaypart(claim, daypart)
    ? GREETING_LINES[daypart]
    : GREETING_CORRECTION_LINES[daypart];
  const pick = pool.find((line) => !wasLastSpoken(line)) ?? pool[0];
  rememberSpokenLine(pick);
  return pick;
}

export interface ComposeGlueDeps extends GenerateGlueDeps {
  /** Force the live model path on/off (tests). Default: flag on AND key
   * present. */
  modelEnabled?: boolean;
  generate?: typeof generateGlueReply;
}

/* Slow-lane BRIDGE line. OFF / no key / call miss: returns the
 * deterministic fallback (the caller's pickBridgeLine hash pick), so the
 * behavior is byte-identical to before. ON + key: a warm, request-
 * specific line from the live model. Always resolves to a spoken line
 * (never null) - the bridge must never be silent, unlike glue which can
 * absorb. The caller fires this WITHOUT awaiting before injecting Lex, so
 * Lex starts reasoning immediately and the bridge speaks the moment it
 * lands (well before an Opus reply). */
export interface ComposeBridgeDeps extends GenerateGlueDeps {
  /** Force the live model path on/off (tests). Default: flag on AND key. */
  modelEnabled?: boolean;
  generate?: typeof generateBridgeReply;
}

export async function composeBridgeReply(
  utterance: string,
  fallback: string,
  deps?: ComposeBridgeDeps,
): Promise<string> {
  const modelEnabled =
    deps?.modelEnabled ?? (useVoiceHaiku() && glueModelAvailable());
  if (!modelEnabled && !deps?.generate) return fallback;
  const gen = deps?.generate ?? generateBridgeReply;
  const reply = await gen({ utterance }, deps);
  return reply ?? fallback;
}

export async function composeGlueReply(
  text: string,
  lastSpoken: string | null,
  deps?: ComposeGlueDeps,
): Promise<string | null> {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,]+$/, '');
  const delivery = deliveryHintOf(t);
  const claim = greetingClaimOf(t);
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
    return (await live('nothing-said')) ?? "I haven't said anything yet.";
  }

  if (claim !== null) {
    /* Greeting-shaped aside (requirement 3/4): prefer the live in-persona
     * line - it can weave the moment/digest in naturally - and fall back
     * to the deterministic time-aware canned pool rather than a bare-ack
     * absorb, so a greeting is never met with silence or a stale filler,
     * even with no key or a call miss, even right after a cold start. */
    const reply = await live('greeting');
    if (reply) return reply;
    return cannedGreeting(claim, deps?.now?.() ?? new Date());
  }

  const reply = await live(delivery ?? 'ack');
  if (reply) return reply;

  /* Deterministic fallback for delivery tweaks. */
  if (delivery === 'slower') return 'Slowing down.';
  if (delivery === 'louder') return 'Speaking up.';
  if (delivery === 'quieter') return 'Going quieter.';
  /* Pure ack / yes-no: absorb, no spoken reply, no Lex round-trip. */
  return null;
}
