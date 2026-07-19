/* Voice top layer v2 (2026-07-15, docs/superpowers/specs/
 * 2026-07-15-voice-top-layer-design.md).
 *
 * The one conversational layer the operator talks to: speech-first,
 * native-voice-chat contract. The model's reply text IS what gets
 * spoken - no JSON verdicts, no lanes, no whitelist, no keyword
 * grammar. Machine-readable exceptions are trailing directive lines
 * the model emits as part of its natural turn (single brain + tools
 * pattern):
 *
 *   FORWARD: <what goes to the deep brain>
 *   CONTROL: <mute|unmute|standby|listen|disable|end_session|
 *             stop_speaking|interrupt_work>
 *
 * Directive lines are stripped from speech. FORWARD rides the existing
 * Lex inject path; CONTROL fires the existing dispatchVoiceCommand
 * effects. There is deliberately NO flag gate and NO deterministic
 * phrase matching here: when the session is unavailable, times out, or
 * returns nothing, the whole utterance forwards to the deep brain -
 * the operator's words are never eaten by the top layer failing.
 *
 * Phase 2 streaming (spec "Voice-brain streaming partials"): when the
 * caller supplies deps.onSpeech, directive-free assistant records are
 * spoken as they land via the ask's onPartial hook, and the final
 * result's speech carries only what was NOT already emitted. Without
 * deps.onSpeech nothing changes; see topLayerTurn for the contract.
 */
import { buildHaikuPersonaPrompt } from './voice-persona.js';
import { getDigest } from './voice-digest.js';
import { buildLocalContext } from './voice-haiku.js';
import { wasLastSpoken, rememberSpokenLine } from './voice-haiku-glue.js';

export type TopLayerControl =
  | 'mute'
  | 'unmute'
  | 'standby'
  | 'listen'
  | 'disable'
  | 'end_session'
  | 'stop_speaking'
  | 'interrupt_work';

export interface TopLayerResult {
  /** What gets spoken out loud, right now (null = say nothing). On a
   * streaming turn (deps.onSpeech) this is only the REMAINDER: the
   * parsed speech minus the prefix already emitted through onSpeech. */
  speech: string | null;
  /** What goes to the deep brain via the existing inject path. */
  forward: string | null;
  /** Device-control effect for dispatchVoiceCommand, or null. */
  control: TopLayerControl | null;
  /** Rethink-vs-finish policy (VOICE-TOP-LAYER-SPEC point 6): true when
   * this utterance arrived mid-TTS and the model judged it did NOT
   * change the in-flight answer (an aside, agreement, or its own echo).
   * The caller resumes the interrupted reply ("finish the thought")
   * instead of forwarding. Only meaningful when ctx.duringTts. */
  finish?: boolean;
  /** Streaming turns only: true when the final parsed speech does not
   * start with the early-emitted prefix (the model rewrote text it had
   * already streamed). speech then carries the FULL parsed speech and
   * the caller decides whether to speak it. Absent otherwise. */
  earlySpeechMismatch?: boolean;
}

/** Ask seam onto the dedicated persistent voice-brain session
 * (src/lex/voice-brain-session.ts askVoice). Tests inject a fake. */
export type AskFn = (args: {
  system: string;
  prompt: string;
  timeoutMs: number;
  /** Streaming hook (voice-brain-session askVoice contract): called
   * once per assistant jsonl record with that record's text as it
   * lands; the promise still resolves with the full concatenated
   * text on end_turn. Only passed when deps.onSpeech is provided. */
  onPartial?: (text: string) => void;
  /** Fix #1 (2026-07-18): conversational asks pass this so a timed-out
   * turn/delivery/pulse fail-safes (null) WITHOUT scoring a liveness
   * strike. The turn timeout is a soft bound, never an error path. */
  noLivenessStrike?: boolean;
}) => Promise<string | null>;

export interface TopLayerDeps {
  /** Injected ask (tests). Default: askVoice on the dedicated
   * voice-brain session. */
  ask?: AskFn;
  /** Early-speech sink. When provided, each directive-free assistant
   * record is emitted here the moment it lands (see topLayerTurn for
   * the exact rules); the resolved result's speech then carries only
   * the remainder. When absent, behavior is byte-identical to the
   * non-streaming path. */
  onSpeech?: (line: string) => void;
  /** Per-ask timeout override (tests). */
  timeoutMs?: number;
  /** Pin the clock (tests). */
  now?: () => Date;
}

export interface TopLayerCtx {
  /** Last line the TTS actually spoke, for verbatim repeats. */
  lastSpoken: string | null;
  /** True when this utterance began while TTS was streaming - the
   * transcript may be Lex's own audio bleeding back in. */
  duringTts: boolean;
  /** True when the deep brain (Lex) is mid-turn; substance still
   * forwards (it queues), status is answered from the digest. */
  lexBusy: boolean;
  deps?: TopLayerDeps;
}

const CONTROLS: ReadonlySet<string> = new Set([
  'mute',
  'unmute',
  'standby',
  'listen',
  'disable',
  'end_session',
  'stop_speaking',
  'interrupt_work',
]);

/* Spoken lines stay short; anything longer than this is a model going
 * off-contract, and speaking all of it would be worse than trimming. */
const MAX_SPEECH_CHARS = 500;

/* 8s, not 4s (2026-07-16 failure 1): this bound is time-to-FIRST-
 * record now (the session layer's idle grace governs once records
 * flow), and measured claude turn latency on this box regularly
 * exceeds 4s - the 04:30:30Z "timeout" was a reply landing right at
 * the 4s bell, scoring liveness strike 1 for nothing. The fail-safe
 * (forward the utterance to Lex) means the only cost of the higher
 * bound is a longer wait when the brain is genuinely hung. */
const DEFAULT_TURN_TIMEOUT_MS = 8000;

function turnTimeoutMs(override?: number): number {
  if (override !== undefined) return override;
  const raw = Number(
    process.env.DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TURN_TIMEOUT_MS;
}

/* Default ask: askVoice on the dedicated persistent voice-brain
 * session. Imported lazily (first production ask) so callers that
 * inject an ask - every test - never load the PTY/session machinery
 * behind it. ESM caches the module, so the import cost is once. */
const defaultAsk: AskFn = async (args) => {
  const mod = await import('../lex/voice-brain-session.js');
  return mod.askVoice(args);
};

const FORWARD_LINE = /^\s*forward:(.*)$/i;
const CONTROL_LINE = /^\s*control:(.*)$/i;
/* Rethink-vs-finish (VOICE-TOP-LAYER-SPEC point 6). A bare directive,
 * no payload: the model emits it (optionally with a colon) to say "this
 * barge did not change my answer, let me finish the thought." */
const FINISH_LINE = /^\s*finish\s*:?\s*$/i;

/* ── fabrication guards (2026-07-16, kill-canned-glue mandate) ───────
 *
 * Live failures: the talk layer recombined digest fragments ("fresh
 * start" in lastDecision, "Say it again?" as openQuestion, an empty
 * last-spoken line) into an invented first-person memory claim ("I
 * can't see the last thing I said - if it's in a chat I can't access
 * it because you have a fresh start") and spoke it as Lex, repeatedly;
 * it also answered an operator complaint in Lex's voice, promising
 * supervisor actions it cannot take. Prompts alone cannot pin this -
 * these deterministic guards do:
 *
 *   1. Substance never reaches the talk model: complaints and
 *      prior-turn meta pre-bypass the ask entirely (silent forward),
 *      as does a repeat request when there is nothing to repeat.
 *   2. Speech that makes first-person memory/visibility claims or
 *      promises actions is stripped (held mid-stream, stripped from
 *      the final parse) and the utterance still reaches Lex. */

const REPEAT_REQUEST_RE =
  /\b(?:say|read)\s+(?:that|it)\s+again\b|\brepeat\s+(?:that|it|yourself)\b|\bsay\s+again\b|\bone\s+more\s+time\b|\bwhat\s+did\s+you\s+(?:just\s+)?say\b/i;

const PRIOR_TURN_RES: readonly RegExp[] = [
  /\byou\s+(?:just\s+|never\s+|already\s+)?(?:said|saying|told|claimed|promised|mentioned)\b/i,
  /\byou\s+(?:keep|kept)\b/i,
  /\byou\s+didn'?t\s+(?:say|finish|answer|reply|respond)\b/i,
  /\bwhy\s+(?:do|did|are|would)\s+you\b/i,
  /\b(?:that'?s|that\s+is)\s+not\s+what\s+(?:you|i)\s+(?:said|asked|meant)\b/i,
  /\blast\s+(?:thing|line|message|reply|answer)\s+(?:you|i)\b/i,
  /\bnever\s+(?:said|wrote|heard)\b/i,
];

/* First-person claims about own memory / visibility / session state.
 * The talk layer has no such state to talk about; every one of these
 * is fabrication (the live invented line hits three of them). */
const SELF_CLAIM_RES: readonly RegExp[] = [
  /\bI\s+(?:can'?t|cannot|don'?t|do\s+not|no\s+longer)\s+(?:see|access|recall|remember|view|find|read)\b/i,
  /\b(?:my|your)\s+(?:memory|context|chat|history)\b/i,
  /\bfresh\s+start\b/i,
  /\bI\s+(?:don'?t|do\s+not)\s+have\s+(?:access|visibility)\b/i,
];

/* First-person commitments to actions. Only Lex (the deep brain)
 * commits to actions; the talk layer hands off via FORWARD. A bare
 * "I'll check" stays legal - it IS the sanctioned handoff phrasing -
 * so the pattern requires a concrete action verb. */
const ACTION_PROMISE_RE =
  /\bI\s*(?:'ll|\s+will|'m\s+going\s+to|\s+am\s+going\s+to)\s+(?:flag|report|file|log|escalate|raise|notify|alert|tell|restart|fix|patch|update|investigate|look\s+into|follow\s+up|make\s+sure|check\s+with|take\s+care)\b/i;

/** True for repeat phrasings ("say that again", "what did you just
 * say"). With a last-spoken line these are answered verbatim by the
 * model; with nothing to repeat they forward silently. */
export function isRepeatRequest(utterance: string): boolean {
  return REPEAT_REQUEST_RE.test(utterance);
}

/* ── P2: the top FIELDS trivial turns itself (2026-07-18 spec) ────────
 *
 * A clearly trivial conversational turn - a greeting, chit-chat, a
 * thank-you, a bare acknowledgement, a sign-off - is answered by the
 * TOP layer directly and NEVER escalated to the deep PTY. Only
 * substance goes down. The decision lives here in the top layer; when
 * unsure, escalate (fail toward substance), so the match is STRICT: the
 * WHOLE normalized utterance must be a trivial phrase, never a
 * substring. "thanks for breaking the build, what happened" is NOT
 * trivial. */
const TRIVIAL_TOP_RES: readonly RegExp[] = [
  /^(?:hi|hey+|hiya|hello+|yo|howdy|sup|heya)$/,
  /^(?:good\s+(?:morning|afternoon|evening|night)|mornin[g']?|evenin[g']?|g'?night)$/,
  /^(?:how\s+(?:are\s+(?:you|ya|things)|is\s+it\s+going|goes\s+it)|how'?s\s+it\s+going|what'?s\s+up|whats\s+up|you\s+good)(?:\s+(?:doing|going))?$/,
  /^(?:thanks|thank\s+you|thanks\s+(?:a\s+lot|so\s+much|man|boss|bud|mate|dude)|thx|ty|cheers|appreciate\s+it|much\s+appreciated|nice\s+work|good\s+work)$/,
  /^(?:ok|okay|k|kk|cool|nice|great|awesome|perfect|sweet|sounds\s+good|got\s+it|gotcha|roger|understood|makes\s+sense|good\s+stuff|right\s+on|word|fair\s+enough)$/,
  /^(?:bye|goodbye|see\s+ya|see\s+you|see\s+you\s+later|later|catch\s+you\s+later|good\s+night|night|take\s+care)$/,
  /^(?:you\s+there|you\s+up|still\s+there|you\s+around)$/,
];

/* Normalize for the trivial match: lowercase, drop trailing sentence
 * punctuation, collapse whitespace, and strip a leading or trailing
 * "lex" address token so "hey lex" / "thanks, lex" / "lex you there"
 * still read as trivial (the operator addresses the voice as Lex). */
function normalizeForTrivial(u: string): string {
  let s = (u ?? '').toLowerCase().trim();
  s = s.replace(/[.,!?;:]+$/g, '').trim();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^lex[\s,]+/, '').replace(/[\s,]+lex$/, '').trim();
  return s;
}

/** True when the entire utterance is an unambiguously trivial turn the
 * top layer must field itself (never escalate). Strict on purpose:
 * anything with real content fails this and escalates. */
export function isTrivialTopTurn(utterance: string): boolean {
  const s = normalizeForTrivial(utterance);
  if (!s) return false;
  return TRIVIAL_TOP_RES.some((re) => re.test(s));
}

/** True when the utterance is a complaint or otherwise references a
 * prior turn / what was or was not said - substance the talk layer
 * must never answer itself. */
export function referencesPriorTurns(utterance: string): boolean {
  return PRIOR_TURN_RES.some((re) => re.test(utterance));
}

/** Classify speech the talk layer must never say: a first-person
 * memory/visibility claim or an action promise. Returns the reason
 * (for logs/tests) or null for benign speech. */
export function guardTopLayerSpeech(speech: string): string | null {
  if (SELF_CLAIM_RES.some((re) => re.test(speech))) {
    return 'self-memory-claim';
  }
  if (ACTION_PROMISE_RE.test(speech)) return 'action-promise';
  return null;
}

/* True when any line of a record's text matches a directive regex.
 * Deliberately the RAW regexes, not the validated parse: an off-token
 * CONTROL: line stays plain text in the final parse, but mid-stream it
 * still reads as directive intent, and holding the record for the
 * final parse is strictly safer than speaking it early. */
function containsDirectiveLine(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (
      FORWARD_LINE.test(line) ||
      CONTROL_LINE.test(line) ||
      FINISH_LINE.test(line)
    )
      return true;
  }
  return false;
}

/* Parse the model's reply text into speech + directives. Exported for
 * tests.
 *
 * - A line starting FORWARD: (case-insensitive, leading whitespace ok)
 *   opens the forward block: the remainder of that line plus following
 *   lines, until another directive line. First block wins; duplicate
 *   FORWARD lines are stripped and ignored.
 * - A line starting CONTROL: whose token (lowercased, trimmed) is one
 *   of the eight controls sets control (first valid wins; later valid
 *   ones are stripped but not honored). Any other CONTROL: line is
 *   NOT a directive - it stays plain text, never a control.
 * - Everything else, joined and trimmed, is speech (null when empty),
 *   capped at MAX_SPEECH_CHARS.
 *
 * Null/empty/whitespace input parses to the all-null result; the
 * fail-safe substitution (forward = utterance) happens in
 * topLayerTurn, which knows the utterance. */
export function parseTopLayerReply(
  raw: string | null | undefined,
): TopLayerResult {
  if (!raw || !raw.trim()) {
    return { speech: null, forward: null, control: null };
  }

  const speechLines: string[] = [];
  const forwardLines: string[] = [];
  let control: TopLayerControl | null = null;
  let finish = false;
  let sawForward = false;
  let collectingForward = false;

  for (const line of raw.split(/\r?\n/)) {
    /* FINISH is the highest-precedence directive: it IS the decision
     * (resume the interrupted thought). It closes any forward block and
     * suppresses stray speech - a FINISH turn speaks/forwards nothing. */
    if (FINISH_LINE.test(line)) {
      finish = true;
      collectingForward = false;
      continue;
    }
    const fwd = line.match(FORWARD_LINE);
    if (fwd) {
      if (!sawForward) {
        sawForward = true;
        collectingForward = true;
        const rest = fwd[1]!.trim();
        if (rest) forwardLines.push(rest);
      } else {
        /* Off-contract duplicate: stripped; the first block is closed
         * and later lines fall back to speech. */
        collectingForward = false;
      }
      continue;
    }
    const ctl = line.match(CONTROL_LINE);
    if (ctl) {
      const token = ctl[1]!.trim().toLowerCase();
      if (CONTROLS.has(token)) {
        if (control === null) control = token as TopLayerControl;
        /* A later valid control is stripped but not honored. Either
         * way a control directive line closes a forward block. */
        collectingForward = false;
        continue;
      }
      /* Unknown token: not a directive. The whole line stays plain
       * text (speech, or forward body mid-block), NEVER a control. */
    }
    if (collectingForward) forwardLines.push(line);
    else speechLines.push(line);
  }

  /* FINISH is the whole decision: resume the interrupted thought,
   * speak/forward nothing. A model that emits FINISH plus stray text is
   * off-contract; the directive wins. */
  if (finish) {
    return { speech: null, forward: null, control: null, finish: true };
  }
  const speechJoined = speechLines.join('\n').trim();
  const speech =
    speechJoined.length === 0
      ? null
      : speechJoined.length > MAX_SPEECH_CHARS
        ? speechJoined.slice(0, MAX_SPEECH_CHARS)
        : speechJoined;
  const forwardJoined = forwardLines.join('\n').trim();
  return { speech, forward: forwardJoined || null, control };
}

/* The speech-first contract, restated on every ask (the session-level
 * prompt is deliberately thin; see voice-brain-session.ts). */
function topLayerSystem(): string {
  return (
    'You are on a live voice call. Reply with what you say out loud, ' +
    'exactly as speech, nothing else. Trivial conversational turns - ' +
    'greetings, chit-chat, thanks, a bare acknowledgement, a sign-off ' +
    '- you answer YOURSELF in one short spoken line with NO FORWARD; ' +
    'only real substance goes to your deeper reasoning. When the turn ' +
    'needs real work, ' +
    'project facts, code, or worker action, add a final line FORWARD: ' +
    "with what to hand to your deeper reasoning, in the operator's " +
    'intent, and keep your spoken part to a natural short handoff. On ' +
    'clear spoken intent for a device control add a final line ' +
    'CONTROL: <name> from exactly: mute unmute standby listen disable ' +
    'end_session stop_speaking interrupt_work. When in doubt: FORWARD. ' +
    'Never invent facts not in the digest. Asked to repeat: speak the ' +
    'exact last-spoken line given below. Complaints, corrections, and ' +
    'anything about a previous turn or what was or was not said: do ' +
    'not answer yourself - output ONLY a FORWARD line, no speech. ' +
    'Never promise actions ("I will flag it"): actions belong to your ' +
    'deeper reasoning, via FORWARD. Never talk about your own memory, ' +
    'context, or what you can or cannot see.'
  );
}

function topLayerPrompt(
  utterance: string,
  ctx: TopLayerCtx,
  now: Date,
): string {
  const persona = buildHaikuPersonaPrompt(getDigest()?.digest ?? null);
  const local = buildLocalContext(now);
  const lines: string[] = [
    persona,
    '',
    '--- LOCAL TIME (calibration only, never say it out loud) ---',
    `It is ${local.timeLabel} on ${local.weekday}, ${local.dateLabel} - ${local.daypart}.`,
  ];
  if (ctx.lastSpoken && ctx.lastSpoken.trim()) {
    lines.push(
      '',
      'Last line you spoke (for repeats; never repeat it unprompted): ' +
        `"${ctx.lastSpoken}"`,
    );
  }
  if (ctx.duringTts) {
    lines.push(
      '',
      'NOTE: you were mid-sentence when this came in. Decide:',
      '- If it does NOT change what you were saying (an aside, a nod,',
      '  "yeah"/"ok"/"right", a "keep going", or your own words echoed',
      '  back), output ONLY the single line FINISH and nothing else. You',
      '  will finish the sentence you were on.',
      '- If it DOES change your answer (a correction, a new direction, a',
      '  question needing a different reply), do NOT output FINISH: drop',
      '  the sentence and respond to the new input (a short spoken line',
      '  and/or a FORWARD). When unsure, treat it as real and respond -',
      '  never FINISH over a genuine correction.',
    );
  }
  if (ctx.lexBusy) {
    lines.push(
      '',
      'NOTE: your deeper brain is mid-task right now. Answer status',
      'questions yourself, from the digest above. New substance should',
      'still get a FORWARD line - it queues and is picked up when the',
      'current turn finishes.',
    );
  }
  lines.push('', `The operator just said, verbatim: "${utterance}"`);
  return lines.join('\n');
}

/* The one smart path: one ask per final transcript, parsed into
 * speech + directives. Never throws.
 *
 * Fail-safe: ask down / timeout / null / empty / whitespace-only reply
 * all parse to the all-null result, which becomes
 * { speech: null, forward: utterance, control: null } - the operator's
 * words always reach Lex. This holds even after early speech already
 * went out on a streaming turn: the caller spoke what it spoke, and
 * the words still reach the deep brain.
 *
 * Never-twice ring (shared with the canned pools via
 * voice-haiku-glue): applied to speech only. A back-to-back repeat of
 * the previous spoken line is absorbed (speech -> null) while forward
 * and control survive; a fresh line is registered in the ring.
 *
 * Streaming (deps.onSpeech provided): the ask gets an onPartial that
 * emits EARLY SPEECH. Each record's text is emitted through onSpeech
 * the moment it lands, as long as no record so far (this one included)
 * has contained a directive line; the first record carrying one stops
 * early emission for the rest of the turn - that record and everything
 * after reach the caller only through the final parse. Early-emitted
 * lines are registered in the never-twice ring as they go out; an
 * early line that would repeat the last spoken line is skipped (not
 * emitted, not registered) and never resurfaces in the remainder. On
 * resolution the full text is parsed as usual and the emitted prefix
 * is subtracted from the parsed speech, so result.speech is only what
 * was NOT already spoken. If the parsed speech does not start with
 * that prefix (the model rewrote streamed text), the FULL parsed
 * speech is returned with earlySpeechMismatch: true and the caller
 * decides.
 *
 * Single-record semantics (the usual voice-brain reply): the record is
 * emitted through onSpeech as it lands and result.speech comes back
 * null - the caller keeps ONE uniform rule, speak every onSpeech line
 * immediately and then speak result.speech if non-null, with no
 * buffering and no single-vs-multi special case. */
export async function topLayerTurn(
  utterance: string,
  ctx: TopLayerCtx,
): Promise<TopLayerResult> {
  const ask = ctx.deps?.ask ?? defaultAsk;
  const onSpeech = ctx.deps?.onSpeech;

  /* Fabrication guards, pre-ask (2026-07-16). A repeat request with
   * nothing to repeat, and any complaint / prior-turn meta, forward
   * silently WITHOUT the talk model ever seeing the turn - answering
   * either from digest fragments is exactly how the invented
   * "I can't see my last message" line was born. Repeat WITH a
   * last-spoken line stays a model turn (it repeats verbatim). */
  const repeatAsk = isRepeatRequest(utterance);
  if (repeatAsk && !(ctx.lastSpoken && ctx.lastSpoken.trim())) {
    return { speech: null, forward: utterance, control: null };
  }
  if (!repeatAsk && referencesPriorTurns(utterance)) {
    return { speech: null, forward: utterance, control: null };
  }

  /* Early-speech state. `consumed` holds every record text handled in
   * the early phase - emitted out loud OR ring-skipped - because
   * either way that text must not be spoken again from the final
   * parse. `stopped` latches on the first directive-bearing record (or
   * a speech-cap breach): from then on records go only through the
   * final parse. */
  const consumed: string[] = [];
  let stopped = false;

  const onPartial =
    onSpeech === undefined
      ? undefined
      : (recordText: string): void => {
          if (stopped) return;
          const text = recordText.trim();
          if (!text) return;
          if (containsDirectiveLine(text)) {
            stopped = true;
            return;
          }
          if (guardTopLayerSpeech(text) !== null) {
            /* Fabrication class (self-memory claim / action promise):
             * never streamed out loud. Held for the final parse, where
             * the guard strips it from speech; NOT consumed, so the
             * subtraction cannot mask the strip. */
            stopped = true;
            return;
          }
          const joined =
            consumed.length === 0 ? text : `${consumed.join('\n')}\n${text}`;
          if (joined.length > MAX_SPEECH_CHARS) {
            /* The final parse caps speech at MAX_SPEECH_CHARS; emitting
             * past the cap would speak text the subtraction could never
             * reconcile. Hold the rest for the final parse. */
            stopped = true;
            return;
          }
          if (wasLastSpoken(text)) {
            /* Never-twice: skipped (not emitted, not registered), but
             * still consumed so the subtraction drops it from the
             * remainder instead of speaking it after all. */
            consumed.push(text);
            return;
          }
          try {
            onSpeech(text);
          } catch {
            /* A throwing sink is the caller's bug; the turn goes on and
             * the line still counts as handled. */
          }
          rememberSpokenLine(text);
          consumed.push(text);
        };

  let raw: string | null = null;
  try {
    const now = ctx.deps?.now?.() ?? new Date();
    raw = await ask({
      system: topLayerSystem(),
      prompt: topLayerPrompt(utterance, ctx, now),
      timeoutMs: turnTimeoutMs(ctx.deps?.timeoutMs),
      noLivenessStrike: true,
      ...(onPartial ? { onPartial } : {}),
    });
  } catch {
    raw = null;
  }
  const result = parseTopLayerReply(raw);
  if (
    result.speech === null &&
    result.forward === null &&
    result.control === null &&
    !result.finish
  ) {
    /* Ask down / timeout / empty: the operator's words always reach Lex.
     * A FINISH is an explicit decision, NOT an all-null fail-safe, so it
     * is exempt - it must resume the thought, never become a forward. */
    return { speech: null, forward: utterance, control: null };
  }
  if (consumed.length > 0) {
    const prefix = consumed.join('\n');
    if (result.speech !== null && result.speech.startsWith(prefix)) {
      const remainder = result.speech.slice(prefix.length).trim();
      result.speech = remainder || null;
    } else {
      result.earlySpeechMismatch = true;
    }
  }
  /* P2: the top FIELDS trivial turns itself. When the utterance is
   * unambiguously trivial (greeting / thanks / ack) AND the top already
   * produced speech to answer it (streamed early and/or a remainder),
   * strip any FORWARD the model over-emitted so NOTHING reaches the
   * deep PTY - the top handled it. Fail toward substance: with no top
   * speech there is nothing to field with, so the forward survives and
   * Lex answers; a non-trivial turn always keeps its forward. */
  const topSpoke = result.speech !== null || consumed.length > 0;
  if (result.forward !== null && topSpoke && isTrivialTopTurn(utterance)) {
    result.forward = null;
  }
  /* Fabrication guard, post-parse: speech carrying a self-memory
   * claim or an action promise is never spoken. The strip must not
   * eat the operator's words - when it leaves no forward and no
   * control, the utterance forwards (same shape as the fail-safe). */
  if (result.speech !== null && guardTopLayerSpeech(result.speech) !== null) {
    result.speech = null;
    delete result.earlySpeechMismatch;
    if (result.forward === null && result.control === null) {
      result.forward = utterance;
    }
  }
  if (result.speech !== null) {
    if (wasLastSpoken(result.speech)) {
      result.speech = null;
    } else {
      rememberSpokenLine(result.speech);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Lex reply delivery: TTS is hooked ONLY to the top layer (operator   */
/* directive 2026-07-15). When Lex's end_turn body lands, the voice    */
/* brain delivers it out loud in its own voice instead of the raw text */
/* being piped into piper.                                             */
/* ------------------------------------------------------------------ */

/* 8s, not 3s (2026-07-16 failure 1): same time-to-first-record
 * reasoning as DEFAULT_TURN_TIMEOUT_MS above. 3s to first record was
 * a coin flip on this box, and a delivery miss costs a raw-fallback
 * restart of the whole spoken reply. */
const DEFAULT_RENDER_TIMEOUT_MS = 8000;

function renderTimeoutMs(override?: number): number {
  if (override !== undefined) return override;
  const raw = Number(
    process.env.DEVNEURAL_VOICE_RENDER_TIMEOUT_MS ?? DEFAULT_RENDER_TIMEOUT_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RENDER_TIMEOUT_MS;
}

function lexReplySystem(): string {
  return (
    'You are on a live voice call. Your deeper reasoning just finished ' +
    'a turn; deliver its answer out loud, in your own voice. Output ' +
    'ONLY the spoken delivery, nothing else: no preamble, no markdown, ' +
    'no directives. Keep every number, decision, negation, blocker, ' +
    'and name EXACTLY as given - you are delivering, not summarizing. ' +
    'Short spoken sentences. Skip code blocks and file paths; refer to ' +
    'them in passing instead of reading them out.'
  );
}

export interface VoiceLexReplyCtx {
  /** Sink for each spoken line as the brain streams its delivery. */
  onSpeech: (line: string) => void;
  /** Optional log channel for delivery anomalies (the module itself
   * is logger-less by design; the WS caller passes its logFn). */
  log?: (msg: string) => void;
  deps?: Pick<TopLayerDeps, 'ask' | 'timeoutMs'>;
}

/* Delivery deadline scaled to the body (2026-07-16 smoke-test fix 4,
 * brain-path half). The flat 3s render bound is fine as a "did the
 * brain even pick this up" gate, but a long body streams from the
 * brain for many seconds; cutting the ask at 3s after partials had
 * already flowed truncated the spoken reply mid-delivery while
 * voiceLexReply still reported delivered=true (first-partial latch),
 * so the raw fallback never fired either. ~15ms per char of body
 * generation headroom, floored at the render bound, capped at 30s. An
 * explicit deps.timeoutMs override still wins untouched (tests). */
const LEX_REPLY_TIMEOUT_CAP_MS = 30_000;

export function lexReplyTimeoutMs(bodyChars: number, override?: number): number {
  if (override !== undefined) return renderTimeoutMs(override);
  const base = renderTimeoutMs();
  return Math.min(
    LEX_REPLY_TIMEOUT_CAP_MS,
    Math.max(base, 2_000 + Math.round(bodyChars * 15)),
  );
}

/* Heartbeat ask timeout. Deliberately looser than the render/turn
 * timeouts (2026-07-16 smoke-test fix 2): a still-on-it pulse that
 * lands 8s late is still a valid pulse (the caller re-checks that Lex
 * is STILL mid-turn before speaking it), whereas a 3s bound made every
 * pulse a coin flip against normal claude turn latency. */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

function heartbeatTimeoutMs(override?: number): number {
  if (override !== undefined) return override;
  const raw = Number(
    process.env.DEVNEURAL_VOICE_HEARTBEAT_TIMEOUT_MS ??
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HEARTBEAT_TIMEOUT_MS;
}

/* Heartbeat through the brain (operator directive 2026-07-15: no
 * hardcoded talking, everything spoken comes from the top layer). One
 * short grounded still-on-it line in Lex's voice; null on any miss -
 * the pulse is skipped, never replaced by a canned phrase. The
 * never-twice ring applies so consecutive pulses cannot repeat. */
export async function voiceHeartbeat(
  lexElapsedMs: number,
  deps?: Pick<TopLayerDeps, 'ask' | 'timeoutMs' | 'now'>,
): Promise<string | null> {
  const ask = deps?.ask ?? defaultAsk;
  const minutes = Math.max(1, Math.round(lexElapsedMs / 60_000));
  const now = deps?.now?.() ?? new Date();
  let raw: string | null = null;
  try {
    raw = await ask({
      system:
        'You are on a live voice call. Your deeper reasoning is still ' +
        'working; the operator has heard silence for a while. Say ONE ' +
        'short natural still-on-it line in your own voice, grounded in ' +
        'the digest when it has anything. Output only the line.',
      prompt:
        buildHaikuPersonaPrompt(getDigest()?.digest ?? null) +
        '\n\n' +
        `It is ${buildLocalContext(now).timeLabel}. Your deeper reasoning ` +
        `has been on the current turn for about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      timeoutMs: heartbeatTimeoutMs(deps?.timeoutMs),
      noLivenessStrike: true,
    });
  } catch {
    raw = null;
  }
  const line = raw?.trim();
  if (!line || containsDirectiveLine(line)) return null;
  if (wasLastSpoken(line)) return null;
  rememberSpokenLine(line);
  return line;
}

/** Outcome of a brain delivery (2026-07-16 failure 1):
 *  - 'delivered': the reply went out in full (streamed to end_turn,
 *    or the resolved text was spoken).
 *  - 'cut': partials were spoken but the ask never closed (idle stall
 *    or the session died mid-stream). The TAIL of Lex's reply was NOT
 *    spoken; the caller must arrange a re-delivery - it must not fall
 *    back raw immediately (that would double-speak the heard prefix).
 *  - 'miss': nothing was spoken (session down, timeout before the
 *    first record, empty delivery). The caller MUST speak the raw
 *    body itself. */
export type LexReplyOutcome = 'delivered' | 'cut' | 'miss';

/** Deliver Lex's reply body through the voice brain. Never throws; a
 * miss can never silence Lex (see LexReplyOutcome). */
export async function voiceLexReply(
  body: string,
  ctx: VoiceLexReplyCtx,
): Promise<LexReplyOutcome> {
  const text = body.trim();
  if (!text) return 'delivered';
  const ask = ctx.deps?.ask ?? defaultAsk;
  let delivered = false;
  const onPartial = (recordText: string): void => {
    const line = recordText.trim();
    if (!line || containsDirectiveLine(line)) return;
    delivered = true;
    try {
      ctx.onSpeech(line);
    } catch {
      /* caller's bug; keep the turn alive */
    }
  };
  let raw: string | null = null;
  try {
    raw = await ask({
      system: lexReplySystem(),
      prompt:
        'Deliver this reply from your deeper reasoning, verbatim on all ' +
        'facts:\n\n' +
        text,
      timeoutMs: lexReplyTimeoutMs(text.length, ctx.deps?.timeoutMs),
      noLivenessStrike: true,
      onPartial,
    });
  } catch {
    raw = null;
  }
  if (delivered) {
    if (raw === null) {
      /* Partials flowed but the ask never closed (idle stall or
       * session death mid-stream): the tail of Lex's reply was NOT
       * spoken. Loud log + 'cut' so the caller re-delivers once the
       * brain is back; speaking raw here would double-talk the heard
       * prefix. */
      ctx.log?.(
        `[voice-top-layer] LEX REPLY DELIVERY CUT MID-STREAM: partials spoken but ask never closed (body=${text.length} chars); tail unspoken`,
      );
      return 'cut';
    }
    return 'delivered';
  }
  /* Non-streaming session path (or a single empty partial): fall back
   * to the resolved text. */
  const spoken = raw?.trim();
  if (spoken && !containsDirectiveLine(spoken)) {
    try {
      ctx.onSpeech(spoken);
    } catch {
      /* caller's bug */
    }
    return 'delivered';
  }
  return 'miss';
}
