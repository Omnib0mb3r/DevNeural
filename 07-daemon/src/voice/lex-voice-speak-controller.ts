/**
 * Speak-queue controller (Fix 40, 2026-05-26).
 *
 * Fixes the cc-pty double-talk regression flagged in
 * `docs/bugs/2026-05-26-cc-pty-double-talk-investigation.md`
 * (Candidate 1 / HIGH). Pre-fix the WS path called `synthesize()`
 * once per speak() and stamped the resulting handle into
 * `state.ttsActive` without cancelling whatever ctx was already
 * there. Multi-segment Lex replies (pre-tool ack + end_turn body)
 * therefore spawned two piper children whose PCM streams both flowed
 * to the client — audible double-talk.
 *
 * The contract operator clarified beyond the investigation doc's
 * "cancel on replace" recommendation:
 *
 *   (a) Within one logical turn (pre-tool ack + end_turn body of the
 *       same assistant message): SERIALIZE. Second piper spawn waits
 *       for the first piper's natural end. No overlap, no cut.
 *
 *   (b) Across a turn boundary (new user inject, or explicit barge
 *       via `killActiveTts` on `utterance-start`): CANCEL. The
 *       in-flight ctx is cancelled, partialChain captures the
 *       intended_text per the existing N-deep barge logic.
 *
 *   (c) Same-turn serialization MUST NOT push a partialChain entry
 *       when the prior segment finishes naturally. partialChain is
 *       for INTERRUPTED replies, not sequential segments.
 *
 * The "same turn" identity is implicit in the queue: every speak()
 * that lands while the controller is draining the queue belongs to
 * the current logical turn. A `killActive()` call (which fires on
 * the `utterance-start` WS frame, on the wake-command hold-up
 * dispatch, and on any other explicit barge) clears the queue and
 * marks the current ctx cancelled — that is the boundary. Anything
 * pushed AFTER killActive starts a fresh queue run.
 *
 * Pure controller. Holds no WS-frame concerns of its own; the WS
 * coordinator passes a `send` + `sendBinary` channel. Tests inject
 * a fake `synthesize` that returns a PassThrough stream they drive
 * manually, so the queue lifecycle can be pinned without piper.
 */
import type { Readable } from 'node:stream';
import { acquireMouth } from './voice-mouth.js';

export interface SynthLikeHandle {
  pcm: Readable;
  cancel: () => void;
  done: Promise<void>;
  sampleRate: number;
}

export interface SpeakControllerState {
  ttsActive: { cancel: () => void; cancelled: boolean } | null;
  currentTtsText: string | null;
  currentTtsStartedAtMs: number;
  partialChain: Array<{
    intended_text: string;
    started_at_ms: number;
    cancelled_at_ms: number;
  }>;
  ttsQueue: Array<{ cleanText: string; continuation?: boolean }>;
  ttsQueueRunning: boolean;
}

export interface SpeakControllerDeps {
  synthesize: (text: string) => SynthLikeHandle;
  send: (frame: Record<string, unknown>) => void;
  sendBinary: (buf: Buffer) => void;
  /** Optional hook fired after a natural tts-end. Production uses
   * this to bump the module-level `lastTtsEndMs`. */
  onTtsEnd?: () => void;
  /** Optional log channel. */
  log?: (msg: string) => void;
  /** Pillar 3.1: label this controller as a mouth source. Each speak
   * source (Lex reply, heartbeat, glue, a second connection) gets a
   * distinct id so the single-mouth lock can keep exactly one stream
   * live. Defaults to a unique per-controller id. */
  mouthOwnerId?: string;
}

export interface SpeakController {
  /** Push text onto the speak queue. Idempotent on empty input.
   * The first call kicks off the drain loop; subsequent calls land
   * onto the same queue and are serialized after the in-flight ctx
   * finishes naturally. Segments that join an active, uncancelled
   * drain are marked continuation so the client chains their audio
   * gaplessly onto the existing playhead instead of resetting it. */
  speak(text: string, opts?: { continuation?: boolean }): void;
  /** Cancel any in-flight ctx + clear the queue. Returns true if a
   * ctx was actually cancelled (so the caller can decide whether to
   * fire the tts-cancel WS frame + the PTY Ctrl+C). Partial-chain
   * capture is gated on `state.currentTtsText` per the existing
   * N-deep barge contract. */
  killActive(): boolean;
  /** Test-only inspection of the current queue depth. */
  _queueDepth(): number;
}

/* Markdown -> spoken-text strip. Same rules as the pre-fix inline
 * speak() at lex-voice-ws.ts:1267-1278. */
function cleanForTts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

let mouthOwnerSeq = 0;

export function createSpeakController(
  state: SpeakControllerState,
  deps: SpeakControllerDeps,
): SpeakController {
  const ownerId = deps.mouthOwnerId ?? `speak-${++mouthOwnerSeq}`;
  /* Set by killActive so a segment queued right after a barge is never
   * marked continuation off the cancelled chain; cleared the next time
   * a fresh (non-continuation) segment starts a new logical turn. */
  let chainBroken = false;
  function speak(text: string, opts?: { continuation?: boolean }): void {
    const clean = cleanForTts(text);
    if (!clean) return;
    /* A segment joining an active drain (or a non-empty queue) is part
     * of the same logical turn as the segment ahead of it: the client
     * should chain its audio onto the existing playhead, not reset it.
     * Explicit opts.continuation forces the flag for callers that know
     * (sentence-split bodies). A barge breaks the chain. */
    const continuation =
      !chainBroken &&
      (opts?.continuation === true ||
        state.ttsQueueRunning ||
        state.ttsQueue.length > 0);
    if (!continuation) chainBroken = false;
    state.ttsQueue.push({ cleanText: clean, continuation });
    if (!state.ttsQueueRunning) {
      void runQueue();
    }
  }

  async function runQueue(): Promise<void> {
    if (state.ttsQueueRunning) return;
    state.ttsQueueRunning = true;
    try {
      while (state.ttsQueue.length > 0) {
        const seg = state.ttsQueue.shift()!;
        await speakOne(seg.cleanText, seg.continuation === true);
      }
    } finally {
      state.ttsQueueRunning = false;
    }
  }

  async function speakOne(clean: string, continuation: boolean): Promise<void> {
    /* Pillar 3.1 single mouth: only one TTS stream may be live across
     * the whole daemon. With the haiku tier OFF this grant is a no-op
     * (current behavior). With it ON, a null grant means another source
     * holds the mouth - defer this segment (front of queue, never lost)
     * and let the drain loop retry when the mouth frees. Within a single
     * controller the queue is already sequential (Fix 51), so the defer
     * path is only reachable cross-source. */
    const grant = acquireMouth(ownerId);
    if (!grant) {
      deps.log?.(`[voice-mouth] busy (held elsewhere); deferring segment`);
      state.ttsQueue.unshift({ cleanText: clean, continuation });
      await new Promise<void>((r) => setTimeout(r, 25));
      return;
    }
    /* The live-haiku restyle that used to run here (renderSegment on
     * render:true bodies) is gone: it inserted a full LLM round trip
     * between Lex's reply landing and the first PCM byte, the verified
     * dominant latency on the reply path (spec v2, 2026-07-15). The
     * body now goes to piper as-is; cleanForTts already stripped
     * markdown at enqueue time. */
    let handle: SynthLikeHandle;
    try {
      handle = deps.synthesize(clean);
    } catch (err) {
      grant.release();
      /* 2026-07-17 item 3: an evening of silence traced to failures
       * that only pushed an error frame at a possibly-dead socket.
       * Scream in the daemon log too. */
      deps.log?.(
        `[voice-tts] TTS SYNTH FAILED: ${(err as Error).message}; reply will be SILENT (text=${JSON.stringify(clean.slice(0, 80))})`,
      );
      deps.send({ t: 'error', code: 'tts', message: (err as Error).message });
      return;
    }
    const ttsCtx = { cancel: handle.cancel, cancelled: false };
    state.ttsActive = ttsCtx;
    state.currentTtsText = clean;
    state.currentTtsStartedAtMs = Date.now();
    /* continuation tells the client this segment belongs to the same
     * logical turn as the audio already scheduled: chain onto the
     * existing playhead instead of resetting it (gapless ack -> body,
     * gapless sentence-split bodies). */
    deps.send({
      t: 'tts-start',
      rate: handle.sampleRate,
      ...(continuation ? { continuation: true } : {}),
    });
    handle.pcm.on('data', (chunk: Buffer) => {
      /* Drop chunks that arrive after a forced cancel — the piper
       * child has been killed but stdout can flush a tail chunk
       * before its FD closes. */
      if (ttsCtx.cancelled) return;
      deps.sendBinary(chunk);
    });
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      handle.pcm.on('end', () => {
        if (ttsCtx.cancelled) {
          /* Cancelled streams have already emitted their tts-cancel
           * at the WS layer; the controller just releases the slot. */
          if (state.ttsActive === ttsCtx) state.ttsActive = null;
          finish();
          return;
        }
        deps.send({ t: 'tts-end' });
        deps.onTtsEnd?.();
        state.ttsActive = null;
        /* Natural completion clears the intended-text capture per
         * the existing partialChain contract (point c of the spec):
         * sequential same-turn segments must NOT show up as
         * interrupted entries. */
        state.currentTtsText = null;
        state.currentTtsStartedAtMs = 0;
        finish();
      });
      handle.pcm.on('error', (err: Error) => {
        deps.log?.(
          `[voice-tts] TTS STREAM ERROR mid-synthesis: ${err.message}; remainder of the reply will be SILENT`,
        );
        deps.send({ t: 'error', code: 'tts-stream', message: err.message });
        state.ttsActive = null;
        finish();
      });
      /* Fix 51 (2026-05-29): DO NOT release the await on handle.done.
       * piper.synthesize resolves `done` on proc.exit, which fires
       * BEFORE the kernel finishes draining piper stdout into the
       * Readable pcm stream. If we released here, runQueue would
       * shift the next queued segment and call speakOne, spawning a
       * second piper child whose PCM starts flowing through
       * sendBinary WHILE the previous ctx's remaining buffered
       * chunks were still being emitted by its own pcm 'data'
       * handler. Two PCM streams to the client = audible
       * double-talk. Wait for pcm 'end' (or 'error') only — those
       * guarantee the readable side is fully drained. handle.done
       * remains available to other consumers (debug logging,
       * tests) but is no longer a release signal. */
    });
    /* Release the single mouth once the stream is fully drained
     * (natural end, cancelled-end, or error all resolve the await
     * above). No-op when the haiku tier is off. */
    grant.release();
  }

  function killActive(): boolean {
    /* Break the continuation chain: anything queued after this barge
     * starts a fresh logical turn and must not chain onto the audio
     * that was just cancelled. */
    chainBroken = true;
    /* Clear the queue regardless of whether a ctx is in flight. The
     * queued segments belong to the same logical turn that just got
     * barged; they must not replay after the barge resolves. */
    if (state.ttsQueue.length > 0) state.ttsQueue = [];
    const ctx = state.ttsActive;
    if (!ctx) return false;
    ctx.cancelled = true;
    try {
      ctx.cancel();
    } catch {
      /* cancel is best-effort */
    }
    state.ttsActive = null;
    /* Partial-chain capture is contract point (c) inverted: this
     * IS an interrupted reply (the kill source is a real barge),
     * so the in-flight intended_text gets recorded for the next
     * user inject's [voice-context] block. The queued-but-not-yet-
     * started segments are NOT recorded — they never made it to
     * piper, so they have no "intended audio" to weave back in. */
    if (state.currentTtsText) {
      state.partialChain.push({
        intended_text: state.currentTtsText,
        started_at_ms: state.currentTtsStartedAtMs,
        cancelled_at_ms: Date.now(),
      });
    }
    state.currentTtsText = null;
    state.currentTtsStartedAtMs = 0;
    return true;
  }

  return {
    speak,
    killActive,
    _queueDepth: () => state.ttsQueue.length,
  };
}

export { cleanForTts as _cleanForTtsForTests };

/* Sentence-boundary split for spoken bodies (spec v2, the confirmed
 * producer-consumer TTS pattern). Lex's reply text arrives as one
 * complete block, so this is a plain split rather than a token buffer:
 * each sentence becomes its own speak() segment, which starts piper on
 * sentence one while the rest queue behind it (continuation-chained,
 * so playback is gapless) and lets a barge-in kill mid-body cleanly.
 * Fragments shorter than MIN_SENTENCE_CHARS merge into their
 * predecessor so abbreviations and clipped interjections do not spawn
 * per-word piper calls. */
const MIN_SENTENCE_CHARS = 12;

export function splitForSpeech(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const rawParts = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const merged: string[] = [];
  for (const part of rawParts) {
    const prev = merged[merged.length - 1];
    if (
      prev !== undefined &&
      (part.length < MIN_SENTENCE_CHARS ||
        prev.length < MIN_SENTENCE_CHARS)
    ) {
      merged[merged.length - 1] = `${prev} ${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged;
}
