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
  ttsQueue: Array<{ cleanText: string }>;
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
}

export interface SpeakController {
  /** Push text onto the speak queue. Idempotent on empty input.
   * The first call kicks off the drain loop; subsequent calls land
   * onto the same queue and are serialized after the in-flight ctx
   * finishes naturally. */
  speak(text: string): void;
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

export function createSpeakController(
  state: SpeakControllerState,
  deps: SpeakControllerDeps,
): SpeakController {
  function speak(text: string): void {
    const clean = cleanForTts(text);
    if (!clean) return;
    state.ttsQueue.push({ cleanText: clean });
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
        await speakOne(seg.cleanText);
      }
    } finally {
      state.ttsQueueRunning = false;
    }
  }

  async function speakOne(clean: string): Promise<void> {
    let handle: SynthLikeHandle;
    try {
      handle = deps.synthesize(clean);
    } catch (err) {
      deps.send({ t: 'error', code: 'tts', message: (err as Error).message });
      return;
    }
    const ttsCtx = { cancel: handle.cancel, cancelled: false };
    state.ttsActive = ttsCtx;
    state.currentTtsText = clean;
    state.currentTtsStartedAtMs = Date.now();
    deps.send({ t: 'tts-start', rate: handle.sampleRate });
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
        deps.send({ t: 'error', code: 'tts-stream', message: err.message });
        state.ttsActive = null;
        finish();
      });
      void handle.done.then(() => {
        if (state.ttsActive === ttsCtx) state.ttsActive = null;
        finish();
      });
    });
  }

  function killActive(): boolean {
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
