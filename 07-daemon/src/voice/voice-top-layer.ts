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
  /** What gets spoken out loud, right now (null = say nothing). */
  speech: string | null;
  /** What goes to the deep brain via the existing inject path. */
  forward: string | null;
  /** Device-control effect for dispatchVoiceCommand, or null. */
  control: TopLayerControl | null;
}

/** Ask seam onto the dedicated persistent voice-brain session
 * (src/lex/voice-brain-session.ts askVoice). Tests inject a fake. */
export type AskFn = (args: {
  system: string;
  prompt: string;
  timeoutMs: number;
}) => Promise<string | null>;

export interface TopLayerDeps {
  /** Injected ask (tests). Default: askVoice on the dedicated
   * voice-brain session. */
  ask?: AskFn;
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
 * words always reach Lex.
 *
 * Never-twice ring (shared with the canned pools via
 * voice-haiku-glue): applied to speech only. A back-to-back repeat of
 * the previous spoken line is absorbed (speech -> null) while forward
 * and control survive; a fresh line is registered in the ring. */
export async function topLayerTurn(
  utterance: string,
  ctx: TopLayerCtx,
): Promise<TopLayerResult> {
  const ask = ctx.deps?.ask ?? defaultAsk;
  let raw: string | null = null;
  try {
    const now = ctx.deps?.now?.() ?? new Date();
    raw = await ask({
      system: topLayerSystem(),
      prompt: topLayerPrompt(utterance, ctx, now),
      timeoutMs: turnTimeoutMs(ctx.deps?.timeoutMs),
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
  if (result.speech !== null) {
    if (wasLastSpoken(result.speech)) {
      result.speech = null;
    } else {
      rememberSpokenLine(result.speech);
    }
  }
  return result;
}
