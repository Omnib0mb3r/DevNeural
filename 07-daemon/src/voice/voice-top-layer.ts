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

const DEFAULT_TURN_TIMEOUT_MS = 4000;

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

/* True when any line of a record's text matches a directive regex.
 * Deliberately the RAW regexes, not the validated parse: an off-token
 * CONTROL: line stays plain text in the final parse, but mid-stream it
 * still reads as directive intent, and holding the record for the
 * final parse is strictly safer than speaking it early. */
function containsDirectiveLine(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (FORWARD_LINE.test(line) || CONTROL_LINE.test(line)) return true;
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
  let sawForward = false;
  let collectingForward = false;

  for (const line of raw.split(/\r?\n/)) {
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
    'exactly as speech, nothing else. When the turn needs real work, ' +
    'project facts, code, or worker action, add a final line FORWARD: ' +
    "with what to hand to your deeper reasoning, in the operator's " +
    'intent, and keep your spoken part to a natural short handoff. On ' +
    'clear spoken intent for a device control add a final line ' +
    'CONTROL: <name> from exactly: mute unmute standby listen disable ' +
    'end_session stop_speaking interrupt_work. When in doubt: FORWARD. ' +
    'Never invent facts not in the digest. Asked to repeat: speak the ' +
    'exact last-spoken line given below.'
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
      'NOTE: this was heard WHILE you were speaking, so it may be your',
      'own line echoed back at you. If it reads like an echo or a',
      'fragment of what you just said, reply with nothing at all: no',
      'speech, no directives.',
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
      ...(onPartial ? { onPartial } : {}),
    });
  } catch {
    raw = null;
  }
  const result = parseTopLayerReply(raw);
  if (
    result.speech === null &&
    result.forward === null &&
    result.control === null
  ) {
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

const DEFAULT_RENDER_TIMEOUT_MS = 3000;

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
  deps?: Pick<TopLayerDeps, 'ask' | 'timeoutMs'>;
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
      timeoutMs: renderTimeoutMs(deps?.timeoutMs),
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

/** Deliver Lex's reply body through the voice brain. Returns true when
 * the brain delivered anything (every line went out via onSpeech);
 * false on miss (session down, timeout, empty delivery) - the caller
 * MUST then speak the raw body itself. Never throws; a miss can never
 * silence Lex. */
export async function voiceLexReply(
  body: string,
  ctx: VoiceLexReplyCtx,
): Promise<boolean> {
  const text = body.trim();
  if (!text) return true;
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
      timeoutMs: renderTimeoutMs(ctx.deps?.timeoutMs),
      onPartial,
    });
  } catch {
    raw = null;
  }
  if (delivered) return true;
  /* Non-streaming session path (or a single empty partial): fall back
   * to the resolved text. */
  const spoken = raw?.trim();
  if (spoken && !containsDirectiveLine(spoken)) {
    try {
      ctx.onSpeech(spoken);
    } catch {
      /* caller's bug */
    }
    return true;
  }
  return false;
}
