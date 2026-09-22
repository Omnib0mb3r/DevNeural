/* Voice top layer, Layer 1 (LAYER-1-CONTROL.md v2, 2026-09-21; history:
 * docs/superpowers/specs/2026-07-15-voice-top-layer-design.md).
 *
 * The one conversational layer the operator talks to: a haiku headless
 * terminal that holds Lex's personality, does ALL the talking, decides
 * what is background noise, sees what the brain (L2) is doing, and
 * controls it. Speech-first, native-voice-chat contract: the model's
 * reply text IS what gets spoken, streamed per record; machine-readable
 * exceptions are trailing directive lines the model emits as part of
 * its natural turn (single brain + tools pattern):
 *
 *   FORWARD: <what goes to the brain, in the operator's intent>
 *   CONTROL: <verb> [argument]
 *   IGNORE:  <two-word reason>
 *
 * Directive lines are stripped from speech. FORWARD rides the existing
 * Lex inject path; CONTROL fires the daemon's dispatch effects; IGNORE
 * drops the utterance (background, other people, own echo). There is
 * deliberately NO flag gate and NO deterministic phrase matching here:
 * when the session is unavailable, times out, or returns nothing, the
 * whole utterance forwards to the brain - the operator's words are
 * never eaten by the top layer failing. IGNORE is a decision the model
 * made, never a fallback.
 *
 * The persona and the contract live in the SPAWN-TIME system prompt
 * (buildTopLayerSystemPrompt, cached by Claude Code); each per-turn
 * message carries only the live block (what the brain and the worker
 * are doing, the last spoken line, the digest, anything pending) and
 * what was heard. */
import { composeVoiceIdentity } from '../lex/persona.js';
import type { LexDigest } from './voice-digest.js';

/* ------------------------------------------------------------------ */
/* Contract vocabulary                                                 */
/* ------------------------------------------------------------------ */

export type TopLayerControl =
  | 'mute'
  | 'unmute'
  | 'standby'
  | 'listen'
  | 'disable'
  | 'end_session'
  | 'stop_speaking'
  | 'interrupt_work'
  | 'cancel_redirect'
  | 'repeat'
  | 'drop_reply'
  | 'combine'
  | 'approve_plan'
  | 'reject_plan'
  | 'confirm_dispatch'
  | 'reject_dispatch';

export const CONTROLS: ReadonlySet<TopLayerControl> = new Set<TopLayerControl>([
  'mute',
  'unmute',
  'standby',
  'listen',
  'disable',
  'end_session',
  'stop_speaking',
  'interrupt_work',
  'cancel_redirect',
  'repeat',
  'drop_reply',
  'combine',
  'approve_plan',
  'reject_plan',
  'confirm_dispatch',
  'reject_dispatch',
]);

/** What the daemon knows about the brain (L2) right now. */
export type MidState = 'down' | 'warming' | 'idle' | 'thinking' | 'tool' | 'replying';

export interface LiveBlock {
  mid: MidState;
  /** Clock ms when the current mid phase started (warming / thinking /
   * tool), null when not applicable. Rendered as elapsed seconds. */
  midSinceMs: number | null;
  /** Tool name while mid === 'tool'. */
  midTool: string | null;
  /** One line about the supervised worker, null when none is bound. */
  worker: string | null;
  /** The last line the voice actually spoke (for repeats). */
  lastSaid: string | null;
  digest: LexDigest | null;
  /** Plan text awaiting the operator's approval (Phase B). */
  pendingPlan: string | null;
  /** A worker dispatch parked by the confirm gate (Phase B). */
  pendingDispatch: { id: string; summary: string } | null;
  /** Clock now, same base as midSinceMs. */
  nowMs: number;
}

export interface TopLayerResult {
  /** What gets spoken out loud (null = nothing, or already streamed). */
  speech: string | null;
  /** What goes to the brain via the existing inject path. */
  forward: string | null;
  control: TopLayerControl | null;
  /** Free text after the verb (a rejection reason, for instance). */
  controlArg: string | null;
  /** Non-null = the model decided this was not for Lex; the reason. */
  ignore: string | null;
}

export type TopLayerEventKind =
  | 'plan-ready'
  | 'plan-result'
  | 'dispatch-pending'
  | 'dispatch-result'
  | 'brain-progress';

export interface TopLayerEvent {
  kind: TopLayerEventKind;
  text: string;
  id?: string;
}

/** Ask seam onto the anchor's persistent voice-brain session
 * (src/lex/voice-brain-session.ts askVoice). Tests inject a fake. */
export type AskFn = (args: {
  anchorId?: string | null;
  /** Optional per-ask framing line. The conversational turn sends none
   * (its contract lives in the spawn prompt); delivery sends one. */
  system?: string;
  prompt: string;
  timeoutMs: number;
  /** Streaming hook (voice-brain-session askVoice contract): called
   * once per assistant jsonl record with that record's text as it
   * lands; the promise still resolves with the full concatenated text
   * on end_turn. */
  onPartial?: (text: string) => void;
  /** Conversational asks pass this so a timed-out turn fail-safes
   * WITHOUT scoring a liveness strike (2026-07-18 fix #1). */
  noLivenessStrike?: boolean;
}) => Promise<string | null>;

export interface TopLayerDeps {
  /** Injected ask (tests). Default: askVoice on the anchor's session. */
  ask?: AskFn;
  /** Early-speech sink: each record's speech (directives stripped) the
   * moment it lands. When present, the resolved result's speech is
   * null (already spoken). */
  onSpeech?: (line: string) => void;
  /** Per-ask timeout override (tests). */
  timeoutMs?: number;
}

export interface TopLayerCtx {
  live: LiveBlock;
  /** True when this utterance began while TTS was playing. */
  duringTts: boolean;
  anchorId: string | null;
  deps?: TopLayerDeps;
}

/* Default ask: askVoice on the anchor's persistent voice-brain session.
 * Imported lazily (first production ask) so callers that inject an ask
 * - every test - never load the PTY/session machinery behind it. ESM
 * caches the module, so the import cost is once. */
const defaultAsk: AskFn = async (args) => {
  const mod = await import('../lex/voice-brain-session.js');
  return mod.askVoice(args);
};

/* ------------------------------------------------------------------ */
/* Spawn-time system prompt                                            */
/* ------------------------------------------------------------------ */

const CONTRACT = `## Your job on this call

You are the voice of Lex on a live call with Michael. A deeper part of
you (the brain) reasons, writes plans and runs the worker; it never
speaks. You speak for both of you, in the first person. Never say
"Lex" in the third person; the only "he" is the worker.

You are his sparring partner: witty, smart, concise. Challenge a soft
premise, push back once, help him get to the point. Sharpen what he
said into the actual ask, then hand the brain ONLY the sharpened
result, never a transcript of the exchange. While the brain works,
keep him posted when it matters, briefly. When the brain replies, say
so in your own words, then deliver its facts exactly.

Every message you receive has a [live] block (what the brain and the
worker are doing right now, your last spoken line, the brain's notes:
current task, last decision, open question, next steps) and a [heard]
line (what Michael just said). Sometimes an [event] line
instead (the brain finished a plan, wants to send the worker something,
or is still working). Decide, every time:

1. Answer yourself when you can: small talk, "what's she doing",
   status from the [live] block, a repeat, a quick clarification.
2. Hand substance to the brain: real work, project facts, decisions,
   anything needing tools or the worker. Say a short natural handoff
   out loud and add a trailing line FORWARD: <the ask, in Michael's
   intent>.
3. Issue a control when the words clearly mean one. Trailing line
   CONTROL: <verb> [argument]. Verbs: mute, unmute, standby, listen,
   disable, end_session, stop_speaking, interrupt_work,
   cancel_redirect (drop what the brain is doing and FORWARD the new
   direction), repeat (say the last thing again), drop_reply (the
   brain's current reply is moot, stop it), combine (fold this into
   the ask still waiting to go down), approve_plan, reject_plan
   <reason>, confirm_dispatch, reject_dispatch <reason>.
4. Ignore background: the TV, other people, a fragment with no address
   to you, your own words echoing back. Trailing line IGNORE: <two-word
   reason>, and say nothing. When unsure whether it was meant for you,
   ask in five words or fewer instead.

Rules: reply text is spoken exactly as written. Directive lines go
LAST, one per line, never inside speech. If the [live] block says the
brain is warming, say so once in the first person ("still waking up,
go on"), keep talking, and still FORWARD; the daemon queues it. If the
brain is thinking or in a tool, you still answer; never wait for it.
Never invent facts that are not in the [live] block or in what the
brain said.

Out loud there is only one of you. The words brain, layer, top, mid,
session, model and deeper reasoning are for this contract, never for
Michael. Still working: "still on it", "give me a moment". Its answer
arrives: "right, got it" or straight into the answer. He must never be
able to tell there are two of you.

If Michael speaks while a brain reply is being delivered (during_tts:
yes), the audio has already stopped. Decide: a correction or a new
direction means the reply is moot, add CONTROL: drop_reply and FORWARD
the new direction; an addition just forwards as a follow-up; a
clarification of the same ask adds CONTROL: combine so the brain gets
one turn. An [event] brain-progress line means the brain is still
working; say a word only if it helps, silence is fine.

When the [live] block shows a plan pending, read its gist in two or
three sentences and ask for a go; Michael's yes becomes
CONTROL: approve_plan, his no becomes CONTROL: reject_plan <why>. When
a dispatch is pending, say what the brain wants to send and to whom,
then ask; yes is CONTROL: confirm_dispatch, no is
CONTROL: reject_dispatch <why>.`;

/** The Layer 1 spawn prompt: shared identity + persona + spoken rules
 * + the job contract. Injected once via --append-system-prompt. */
export function buildTopLayerSystemPrompt(): string {
  return [composeVoiceIdentity(), CONTRACT].join('\n\n');
}

/* ------------------------------------------------------------------ */
/* Per-turn message                                                    */
/* ------------------------------------------------------------------ */

function elapsedLabel(live: LiveBlock): string {
  if (live.midSinceMs === null) return '';
  const s = Math.max(0, Math.round((live.nowMs - live.midSinceMs) / 1000));
  return ` ${s}s`;
}

function digestField(value: string): string {
  const v = value.trim();
  return v.length > 0 ? v : '(none)';
}

function oneLine(text: string, cap: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, cap);
}

export function renderLiveBlock(live: LiveBlock): string {
  let brain: string;
  switch (live.mid) {
    case 'tool':
      brain = `tool ${live.midTool ?? 'unknown'}${elapsedLabel(live)}`;
      break;
    case 'thinking':
    case 'warming':
      brain = `${live.mid}${elapsedLabel(live)}`;
      break;
    default:
      brain = live.mid;
  }
  const lines = [`[live] brain: ${brain}`];
  if (live.worker !== null) lines.push(`       worker: ${live.worker}`);
  if (live.lastSaid) lines.push(`       last said: ${JSON.stringify(live.lastSaid)}`);
  if (live.digest) {
    lines.push(
      `       Current task: ${digestField(live.digest.currentTask)}`,
      `       Last decision: ${digestField(live.digest.lastDecision)}`,
      `       Open question: ${digestField(live.digest.openQuestion)}`,
      `       Next steps: ${digestField(live.digest.nextSteps)}`,
    );
  }
  if (live.pendingPlan) {
    lines.push(`       plan pending: ${oneLine(live.pendingPlan, 600)}`);
  }
  if (live.pendingDispatch) {
    lines.push(
      `       dispatch pending (${live.pendingDispatch.id}): ${oneLine(live.pendingDispatch.summary, 200)}`,
    );
  }
  return lines.join('\n');
}

export function buildTopLayerTurnMessage(
  utterance: string,
  live: LiveBlock,
  opts: { duringTts: boolean; words: number },
): string {
  return `${renderLiveBlock(live)}\n[heard] ${JSON.stringify(utterance)}  (during_tts: ${opts.duringTts ? 'yes' : 'no'}, words: ${opts.words})`;
}

export function buildTopLayerEventMessage(event: TopLayerEvent, live: LiveBlock): string {
  const tag = event.id ? `${event.kind} ${event.id}` : event.kind;
  return `${renderLiveBlock(live)}\n[event] ${tag}: ${event.text}`;
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

const FORWARD_LINE = /^\s*forward:(.*)$/i;
const CONTROL_LINE = /^\s*control:\s*([a-z_]+)\s*(.*)$/i;
const IGNORE_LINE = /^\s*ignore:(.*)$/i;

/* Spoken lines stay short; anything longer than this is a model going
 * off-contract, and speaking all of it would be worse than trimming. */
const MAX_SPEECH_CHARS = 600;

function isControlLine(line: string): boolean {
  const m = line.match(CONTROL_LINE);
  return Boolean(m && CONTROLS.has(m[1]!.toLowerCase() as TopLayerControl));
}

/* True when any line of a record's text is a directive. Used by the
 * delivery path, which must never speak a directive-shaped record. */
function containsDirectiveLine(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    if (FORWARD_LINE.test(line) || isControlLine(line) || IGNORE_LINE.test(line)) {
      return true;
    }
  }
  return false;
}

/** The record's text with every directive line removed, trimmed. */
export function speechOnly(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !FORWARD_LINE.test(line) && !isControlLine(line) && !IGNORE_LINE.test(line),
    )
    .join('\n')
    .trim();
}

const EMPTY_RESULT: TopLayerResult = {
  speech: null,
  forward: null,
  control: null,
  controlArg: null,
  ignore: null,
};

/* Parse the model's reply text into speech + directives. Exported for
 * tests.
 *
 * - A line starting FORWARD: (case-insensitive, leading whitespace ok)
 *   opens the forward block: the remainder of that line plus following
 *   lines, until another directive line. First block wins; duplicate
 *   FORWARD lines are stripped and ignored.
 * - A line starting CONTROL: whose verb is in CONTROLS sets control
 *   (first valid wins; later valid ones are stripped but not honored);
 *   free text after the verb is controlArg. Any other CONTROL: line is
 *   NOT a directive - it stays plain text, never a control.
 * - A line starting IGNORE: sets the ignore reason (first wins).
 * - Everything else, joined and trimmed, is speech (null when empty),
 *   capped at MAX_SPEECH_CHARS.
 *
 * Null/empty/whitespace input parses to the all-null result; the
 * fail-safe substitution (forward = utterance) happens in
 * topLayerTurn, which knows the utterance. */
export function parseTopLayerReply(raw: string | null | undefined): TopLayerResult {
  if (!raw || !raw.trim()) return { ...EMPTY_RESULT };

  const speechLines: string[] = [];
  const forwardLines: string[] = [];
  let control: TopLayerControl | null = null;
  let controlArg: string | null = null;
  let ignore: string | null = null;
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
      const verb = ctl[1]!.toLowerCase() as TopLayerControl;
      if (CONTROLS.has(verb)) {
        if (control === null) {
          control = verb;
          controlArg = ctl[2]?.trim() || null;
        }
        collectingForward = false;
        continue;
      }
      /* Unknown verb: not a directive. The whole line stays plain text
       * (speech, or forward body mid-block), NEVER a control. */
    }
    const ign = line.match(IGNORE_LINE);
    if (ign) {
      if (ignore === null) ignore = ign[1]!.trim() || 'unspecified';
      collectingForward = false;
      continue;
    }
    if (collectingForward) forwardLines.push(line);
    else speechLines.push(line);
  }

  const speechJoined = speechLines.join('\n').trim();
  return {
    speech: speechJoined ? speechJoined.slice(0, MAX_SPEECH_CHARS) : null,
    forward: forwardLines.join('\n').trim() || null,
    control,
    controlArg,
    ignore,
  };
}

/* ------------------------------------------------------------------ */
/* Turns                                                               */
/* ------------------------------------------------------------------ */

/* Time-to-first-record bound (the session layer's idle grace governs
 * once records flow). Measured claude turn latency on this box regularly
 * exceeds 4s; the fail-safe (forward the utterance) means the only cost
 * of a higher bound is a longer wait when the brain is genuinely hung. */
const DEFAULT_TURN_TIMEOUT_MS = 8_000;

function turnTimeoutMs(override?: number): number {
  if (override !== undefined) return override;
  const raw = Number(
    process.env.DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TURN_TIMEOUT_MS;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/* One ask, streamed: each record's speech (directives stripped) goes to
 * onSpeech the moment it lands; the resolved text is parsed for the
 * directives. When anything streamed, the result's speech is null
 * (already spoken). Never throws; a failed ask returns null raw. */
async function runAsk(
  prompt: string,
  ctx: TopLayerCtx,
): Promise<{ result: TopLayerResult; streamed: boolean; raw: string | null }> {
  const ask = ctx.deps?.ask ?? defaultAsk;
  const onSpeech = ctx.deps?.onSpeech;
  let streamed = false;
  const onPartial = onSpeech
    ? (recordText: string): void => {
        const sp = speechOnly(recordText);
        if (!sp) return;
        streamed = true;
        try {
          onSpeech(sp);
        } catch {
          /* a throwing sink is the caller's bug; the turn goes on */
        }
      }
    : undefined;
  let raw: string | null = null;
  try {
    raw = await ask({
      anchorId: ctx.anchorId,
      prompt,
      timeoutMs: turnTimeoutMs(ctx.deps?.timeoutMs),
      noLivenessStrike: true,
      ...(onPartial ? { onPartial } : {}),
    });
  } catch {
    raw = null;
  }
  const result = parseTopLayerReply(raw);
  if (streamed) result.speech = null;
  return { result, streamed, raw };
}

function isAllNull(r: TopLayerResult): boolean {
  return (
    r.speech === null &&
    r.forward === null &&
    r.control === null &&
    r.ignore === null
  );
}

/** One operator utterance -> one L1 turn. Fail-safe: ask down, timeout,
 * empty or unparseable reply all become { forward: utterance } so the
 * operator's words always reach the brain. IGNORE is only ever a
 * decision the model made. */
export async function topLayerTurn(
  utterance: string,
  ctx: TopLayerCtx,
): Promise<TopLayerResult> {
  const prompt = buildTopLayerTurnMessage(utterance, ctx.live, {
    duringTts: ctx.duringTts,
    words: countWords(utterance),
  });
  const { result, streamed } = await runAsk(prompt, ctx);
  if (!streamed && isAllNull(result)) {
    return { ...EMPTY_RESULT, forward: utterance };
  }
  return result;
}

/** A daemon-originated event (plan ready, dispatch pending, brain
 * progress) handed to L1. Never fail-safe-forwards: a null ask is
 * silence, and a FORWARD in the reply is honored only when the model
 * chose to produce one. */
export async function topLayerEventTurn(
  event: TopLayerEvent,
  ctx: TopLayerCtx,
): Promise<TopLayerResult> {
  const prompt = buildTopLayerEventMessage(event, ctx.live);
  const { result } = await runAsk(prompt, ctx);
  return result;
}

/* ------------------------------------------------------------------ */
/* Lex reply delivery: TTS is hooked ONLY to the top layer (operator   */
/* directive 2026-07-15). When the brain's end_turn body lands, the    */
/* voice delivers it out loud in its own voice instead of the raw text */
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
    'Your deeper reasoning (the brain) just finished a turn; deliver ' +
    'its answer out loud, in your own voice. Open with a few words of ' +
    'your own that make clear the brain is back with it, then deliver. ' +
    'Output ONLY the spoken delivery: no markdown, no directive lines. ' +
    'Keep every number, decision, negation, blocker, and name EXACTLY ' +
    'as given - you are delivering, not summarizing. Short spoken ' +
    'sentences. Skip code blocks and file paths; refer to them in ' +
    'passing instead of reading them out.'
  );
}

export interface VoiceLexReplyCtx {
  /** Sink for each spoken line as the brain streams its delivery. */
  onSpeech: (line: string) => void;
  /** The anchor whose voice delivers. */
  anchorId?: string | null;
  /** Optional log channel for delivery anomalies (the module itself
   * is logger-less by design; the WS caller passes its logFn). */
  log?: (msg: string) => void;
  deps?: Pick<TopLayerDeps, 'ask' | 'timeoutMs'>;
}

/* Delivery deadline scaled to the body (2026-07-16 smoke-test fix 4,
 * brain-path half). The flat render bound is fine as a "did the brain
 * even pick this up" gate, but a long body streams from the brain for
 * many seconds; cutting the ask after partials had already flowed
 * truncated the spoken reply mid-delivery. ~15ms per char of body
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
 * still-on-it cue is a Layer 1 decision on a brain-progress event, not
 * a daemon-generated line. */

/** Outcome of a brain delivery (2026-07-16 failure 1):
 *  - 'delivered': the reply went out in full (streamed to end_turn,
 *    or the resolved text was spoken).
 *  - 'cut': partials were spoken but the ask never closed (idle stall
 *    or the session died mid-stream). The TAIL of the reply was NOT
 *    spoken. The caller must NOT re-deliver from the top (that would
 *    re-speak the heard prefix); the full text stays readable in the
 *    transcript (single-mouth invariant 6).
 *  - 'miss': nothing was spoken (session down, timeout before the
 *    first record, empty delivery). The caller MUST speak the raw
 *    body itself, once. */
export type LexReplyOutcome = 'delivered' | 'cut' | 'miss';

/** Deliver the brain's reply body through the voice. Never throws; a
 * miss can never silence the brain (see LexReplyOutcome). */
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
      anchorId: ctx.anchorId ?? null,
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
       * session death mid-stream): the tail of the reply was NOT
       * spoken. Loud log + 'cut'; the caller never re-speaks. */
      ctx.log?.(
        `[voice-top-layer] LEX REPLY DELIVERY CUT MID-STREAM: partials spoken but ask never closed (body=${text.length} chars); tail unspoken, full text in transcript`,
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
