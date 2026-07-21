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
  /** Early-speech sink for streamed directive-free records. */
  onSpeech?: (line: string) => void;
  /** Per-ask timeout override (tests). */
  timeoutMs?: number;
  /** Pin the clock (tests). */
  now?: () => Date;
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

/* The spoken "still working" heartbeat pulse is gone (operator
 * directive 2026-07-21: no hard-coded spoken heartbeats, ever). Any
 * still-on-it cue will be reborn as a Layer 1 system-prompt behavior,
 * not a daemon-generated line. */

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
