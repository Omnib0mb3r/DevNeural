/* Haiku wiring (pillar 3 capstone).
 *
 * Thin flag-gated helpers the live voice WS calls. Each one is a pure
 * passthrough when DEVNEURAL_VOICE_HAIKU is OFF, so the current voice
 * path stays byte-identical: renderForSpeech is the identity, haikuRoute
 * returns null (the WS skips the haiku block entirely), and heartbeatLine
 * is the existing phrase. Keeping the flag logic here (not inline in the
 * 2000-line WS handler) makes "flag-off is unchanged" unit-testable.
 */
import { useVoiceHaiku, daypartOf, buildLocalContext } from './voice-haiku.js';
import { renderSpoken, renderSpokenAsync } from './voice-renderer.js';
import { frontDeskDecision, type FrontDeskDecision } from './voice-frontdesk.js';
import { composeHeartbeat } from './voice-heartbeat-haiku.js';
import { heartbeatPhrase } from './lex-voice-heartbeat.js';
import {
  glueModelAvailable,
  renderReplyLive,
  wasLastSpoken,
  rememberSpokenLine,
} from './voice-haiku-glue.js';
import { getDigest } from './voice-digest.js';
import { askText } from '../lex/judge-session.js';

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

/* Fast-lane glue responder. BF-4 safe.
 *
 * Live path (2026-07-15 rework, see the fuller doc comment further down):
 * the warm/varied/in-persona reply comes from askText on the persistent
 * Max-plan judge session, grounded in the digest. The deterministic lines
 * further down are the SILENCE GUARD only - taken when the session is
 * disabled, unavailable, or the ask times out - never the primary path.
 *
 * Repeat / "say again" stays a deterministic VERBATIM replay of the last
 * spoken line: repeating must not be paraphrased (it would risk the V5
 * preserve-list). Only the empty-replay case (nothing said yet) and the
 * acks / delivery tweaks go to askText.
 *
 * async: the live path awaits one askText call, bounded to
 * DEVNEURAL_GLUE_ASK_TIMEOUT_MS (default 4000ms). It is fail-fast; a miss
 * returns the deterministic guard line, never a hang. */
const REPEAT_RE =
  /^(say (that )?again|repeat( that)?|come again|what did you say|pardon|one more time|can you repeat( that)?)$/;

function deliveryHintOf(t: string): 'slower' | 'louder' | 'quieter' | null {
  if (/^(slower|speak slower|slow down)$/.test(t)) return 'slower';
  if (/^(louder|speak up|speak louder|a bit louder)$/.test(t)) return 'louder';
  if (/^(quieter|speak quieter)$/.test(t)) return 'quieter';
  return null;
}

/* Greeting handling (2026-07-14, reworked 2026-07-15). Operator
 * complaint: "good morning" / "good afternoon" landed a canned "on it" or
 * a bridge filler ("checking now") because greetings were not in the
 * deny-by-default whitelist at all - they always queued to Lex,
 * digest-fresh or not, cold start or not. Fixed here (owned files only):
 * a small whole-utterance greeting matcher and a route override so a
 * greeting always answers on the fast lane (see haikuRoute below). The
 * reply itself is now the persistent session's askText (see the doc
 * comment further down); the two-line neutral pool immediately below is
 * only the silence guard for when that call is unavailable. */

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

/* 2026-07-15 rework: voice small talk onto the persistent judge session.
 *
 * Operator directives, verbatim intent: "nobody asked for canned
 * greetings, we have AI, it should be a smart thoughtful greeting, just
 * prompt it to do that" + "keep the child sessions open, I'm not paying
 * every time" + "what human cares about time of day when somebody greets
 * them" - goal is Claude voice chat speed and feel.
 *
 * ONE smart path: every greeting AND general glue aside (acks, delivery
 * tweaks, an empty "say again") is answered by askText on the persistent
 * Max-plan judge session (src/lex/judge-session.ts, committed 8d36e93) -
 * the same session that already answers the async judges, kept open for
 * exactly this reason, so there is no per-call metered cost. The metered
 * live Haiku path (generateGlueReply/generateBridgeReply below) is
 * retired from this file; see the deprecation notes on those functions
 * in voice-haiku-glue.ts.
 *
 * ONE tiny silence guard: askGlue returning null (flag off, session
 * unavailable, or the 4s timeout) falls back to a small deterministic
 * pool so the fast lane is never actually silent. For greetings that
 * pool is now just two neutral lines (guardGreeting below) - the
 * operator's point is that nobody cares about a precisely-worded time of
 * day, they care that something warm was said back. Non-greeting glue
 * keeps its existing deterministic lines (Slowing down. / Speaking up. /
 * Going quieter. / "I haven't said anything yet." / null-absorb for a
 * bare ack) as the same kind of guard, unchanged.
 *
 * BF-4 (unchanged boundary): the persistent session is Claude Code, the
 * same trust class as Lex herself, but the input contract does not
 * loosen - persona + digest + the user's aside verbatim is still the
 * FULL input; no raw transcript content is ever added to the prompt. */

const GREETING_GUARD_MORNING = 'Morning.';
const GREETING_GUARD_OTHER = 'Hey.';

/* Silence-guard-only greeting fallback (askGlue null/timeout). No
 * correction logic, no per-daypart pool - "what human cares about time
 * of day when somebody greets them" - just one of two neutral lines,
 * picked by a coarse morning/not-morning split, sharing the never-twice
 * ring with everything else so it does not echo back-to-back. */
function guardGreeting(now: Date): string {
  const daypart = daypartOf(now.getHours());
  const primary: string =
    daypart === 'morning' || daypart === 'early morning'
      ? GREETING_GUARD_MORNING
      : GREETING_GUARD_OTHER;
  const other = primary === GREETING_GUARD_MORNING ? GREETING_GUARD_OTHER : GREETING_GUARD_MORNING;
  const pick = wasLastSpoken(primary) ? other : primary;
  rememberSpokenLine(pick);
  return pick;
}

export interface ComposeGlueDeps {
  /** Per-ask timeout override (tests). Default:
   * DEVNEURAL_GLUE_ASK_TIMEOUT_MS env var, else 4000ms. */
  timeoutMs?: number;
  /** Test seam: pin the local-context / guard clock. Default: real time,
   * read fresh at call time. */
  now?: () => Date;
}

const DEFAULT_GLUE_ASK_TIMEOUT_MS = 4000;

function glueAskTimeoutMs(deps: ComposeGlueDeps | undefined): number {
  if (deps?.timeoutMs !== undefined) return deps.timeoutMs;
  return Number(
    process.env.DEVNEURAL_GLUE_ASK_TIMEOUT_MS ?? DEFAULT_GLUE_ASK_TIMEOUT_MS,
  );
}

/* Persona line for the persistent session's ask. Short: the session
 * already carries its own daemon-utility system prompt
 * (JUDGE_SESSION_SYSTEM_PROMPT); this is the [text]-turn framing that
 * puts it in Lex's first-person voice for this one spoken line. */
function glueAskSystem(): string {
  return (
    'You are Lex, speaking out loud on a live voice call with the operator ' +
    'right now - the same identity as your persistent session, just using ' +
    'your voice for this one line.'
  );
}

/* The full askText prompt body: digest (lastDecision/openQuestion when
 * present), local time as calibration ONLY, and the aside verbatim - see
 * the module doc comment above for the BF-4 boundary this holds to. */
function glueAskPrompt(aside: string, lastSpoken: string | null, now: Date): string {
  const digest = getDigest()?.digest ?? null;
  const digestLines: string[] = [];
  if (digest?.lastDecision) digestLines.push(`Last decision: ${digest.lastDecision}`);
  if (digest?.openQuestion) digestLines.push(`Open question: ${digest.openQuestion}`);
  const ctx = buildLocalContext(now);
  const lines = [
    '--- LIVE DIGEST (what you were just doing, if anything) ---',
    digestLines.length > 0
      ? digestLines.join('\n')
      : '(nothing yet - no digest has landed)',
    '',
    '--- LOCAL TIME (calibration only) ---',
    `It is ${ctx.timeLabel} on ${ctx.weekday}, ${ctx.dateLabel} - ${ctx.daypart}.`,
    'Use the clock ONLY to avoid a mismatched greeting (for example, do not',
    'say "good morning" late at night). Never mention the time, the date,',
    'or the day of week out loud - nobody asked what time it is.',
    '',
    `The operator just said, verbatim: "${aside}"`,
    '',
    'Reply the way a colleague would: if there is anything meaningful in',
    'the digest above (what the worker or the brainstorm was doing), lead',
    'with that naturally, in your own words. Speak in ONE short spoken',
    'sentence - warm, natural, no preamble, no throat-clearing lead-in.',
  ];
  if (lastSpoken && lastSpoken.trim()) {
    lines.push('', `Never repeat this line - you just said it: "${lastSpoken}"`);
  }
  return lines.join('\n');
}

/* The one smart path. Returns null on disabled/unavailable/timeout/empty
 * (the caller then uses its own tiny deterministic guard) or on an exact
 * back-to-back repeat of the last spoken line (never-twice ring, shared
 * with the guard via wasLastSpoken/rememberSpokenLine). Never throws. */
async function askGlue(
  aside: string,
  lastSpoken: string | null,
  deps: ComposeGlueDeps | undefined,
): Promise<string | null> {
  const now = deps?.now?.() ?? new Date();
  try {
    const reply = await askText({
      system: glueAskSystem(),
      prompt: glueAskPrompt(aside, lastSpoken, now),
      timeoutMs: glueAskTimeoutMs(deps),
    });
    const cleaned = reply?.trim();
    if (!cleaned) return null;
    if (wasLastSpoken(cleaned)) return null;
    rememberSpokenLine(cleaned);
    return cleaned;
  } catch {
    return null;
  }
}

/* Slow-lane BRIDGE line. The bridge's entire purpose is to fill the
 * silence the INSTANT Lex starts reasoning, well before her real reply
 * lands - it must fire immediately. A judge-session askText round trip
 * (2-4s, even though it costs nothing extra to call) would BE the delay
 * the bridge exists to hide, so this stays the caller's own instant
 * deterministic pick (dec.route.bridge, built by voice-lane-router.ts's
 * pickBridgeLine) with no model call of any kind, live or persistent.
 * generateBridgeReply (voice-haiku-glue.ts) stays exported and tested,
 * marked deprecated, but is no longer called from here. Kept as an async
 * function (not inlined at the call site) so lex-voice-ws.ts's
 * `.then(...)` call shape needs no change and a model path could be
 * re-added here later without touching the WS again. */
export async function composeBridgeReply(
  _utterance: string,
  fallback: string,
): Promise<string> {
  return fallback;
}

export async function composeGlueReply(
  text: string,
  lastSpoken: string | null,
  deps?: ComposeGlueDeps,
): Promise<string | null> {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,]+$/, '');
  const delivery = deliveryHintOf(t);
  const claim = greetingClaimOf(t);

  if (REPEAT_RE.test(t)) {
    /* Verbatim replay of what was actually said; never the model. */
    if (lastSpoken && lastSpoken.trim()) return lastSpoken;
    const reply = await askGlue(text, lastSpoken, deps);
    return reply ?? "I haven't said anything yet.";
  }

  if (claim !== null) {
    /* Greeting-shaped aside: the persistent session is primary - it can
     * weave the digest / moment in naturally, in Lex's own voice, the
     * way a human colleague would. The two-line neutral guard fires ONLY
     * on null/timeout (guardGreeting above), so a greeting is never met
     * with silence, even with the session unavailable or right after a
     * cold start. */
    const reply = await askGlue(text, lastSpoken, deps);
    if (reply) return reply;
    return guardGreeting(deps?.now?.() ?? new Date());
  }

  const reply = await askGlue(text, lastSpoken, deps);
  if (reply) return reply;

  /* Deterministic fallback for delivery tweaks (guard only, unchanged). */
  if (delivery === 'slower') return 'Slowing down.';
  if (delivery === 'louder') return 'Speaking up.';
  if (delivery === 'quieter') return 'Going quieter.';
  /* Pure ack / yes-no: absorb, no spoken reply, no round-trip. */
  return null;
}

/* Fast-lane transcript hole fix (2026-07-15).
 *
 * When the 'fast' lane above answers with a spoken glue reply, the
 * exchange is absorbed entirely on the daemon side: nothing is ever
 * injected into Lex's PTY, so it never reaches her jsonl and never
 * reaches her awareness. lex-voice-ws.ts persists both sides of an
 * absorbed exchange durably (see _captureAbsorbedAsideImpl there) and
 * also queues it onto a bounded per-connection ring so Lex can be told
 * about it on her NEXT real turn without forcing an extra round-trip.
 * The three helpers below are the pure (no DB, no socket) half of that
 * fix: ring bookkeeping and the text block rendered as an inject
 * prefix. Conversation mode only (shouldCaptureAbsorbedAside) - notes
 * mode already has its own capture-only path for unaddressed
 * utterances and a different spoken-reply contract (silent), and this
 * fix must not touch either. */

export interface AbsorbedAsideEntry {
  atMs: number;
  aside: string;
  reply: string;
}

/** True only for conversation mode. An ADDRESSED notes-mode utterance
 * can still reach the 'fast' lane branch (the name-gate only screens
 * UNADDRESSED ones), but notes mode already owns its capture story
 * (captureNotesUtteranceOnly) and never speaks TTS; this keeps the
 * ring/capture fix from touching that path at all. push-to-talk is
 * likewise excluded - the operator's requirement scoped this to
 * conversation mode explicitly. */
export function shouldCaptureAbsorbedAside(
  mode: 'conversation' | 'notes' | 'push-to-talk',
): boolean {
  return mode === 'conversation';
}

/** Accumulation cap: oldest entries drop silently once the ring holds
 * more than this many. Separate from the smaller DISPLAY cap in
 * _formatAbsorbedAsideBlockImpl below - the ring can hold up to this
 * many, but only the most recent few are ever rendered into an inject
 * prefix. */
export const ABSORBED_ASIDE_RING_MAX = 10;

/** Pure append-and-cap. Returns a new array; never mutates `ring`. */
export function _pushAbsorbedAsideImpl(
  ring: AbsorbedAsideEntry[],
  entry: AbsorbedAsideEntry,
  max: number = ABSORBED_ASIDE_RING_MAX,
): AbsorbedAsideEntry[] {
  const next = ring.concat(entry);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Display cap for the rendered block: at most this many lines, most
 * recent first-out (oldest dropped first). Independent of
 * ABSORBED_ASIDE_RING_MAX (the ring can carry more than this; the
 * prefix just never shows more than this many). */
const ABSORBED_ASIDE_BLOCK_MAX_LINES = 3;

/** Renders the ring as a one-line-per-aside inject prefix, e.g.
 * `[voice asides since last turn: "good morning" -> "Morning."]` for
 * a single entry, or a multi-line block (still one bracket) for more
 * than one, with a "(+N more)" header suffix when the ring holds more
 * than ABSORBED_ASIDE_BLOCK_MAX_LINES entries. '' for an empty ring -
 * the caller adds no prefix at all in that case. Pure; does not
 * mutate or clear the ring (the caller owns that, only after a
 * successful inject). */
export function _formatAbsorbedAsideBlockImpl(
  ring: ReadonlyArray<AbsorbedAsideEntry>,
): string {
  if (ring.length === 0) return '';
  const dropped = Math.max(0, ring.length - ABSORBED_ASIDE_BLOCK_MAX_LINES);
  const shown = ring.slice(-ABSORBED_ASIDE_BLOCK_MAX_LINES);
  const lines = shown.map((e) => `"${e.aside}" -> "${e.reply}"`);
  const header =
    dropped > 0
      ? `voice asides since last turn (+${dropped} more):`
      : 'voice asides since last turn:';
  if (lines.length === 1) return `[${header} ${lines[0]}]`;
  return `[${header}\n${lines.join('\n')}]`;
}
