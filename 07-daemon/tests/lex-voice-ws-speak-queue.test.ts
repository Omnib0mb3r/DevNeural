/**
 * Speak-queue controller (Fix 40, 2026-05-26).
 *
 * Pins the four contract scenarios operator stated when expanding
 * the investigation doc into a fix:
 *
 *   (1) Two same-turn speak() calls produce SEQUENTIAL piper spawns.
 *       ctx1 finishes naturally, then ctx2 spawns. ctx1.cancelled
 *       stays false.
 *   (2) killActive() mid-queue cancels the in-flight ctx AND drops
 *       all queued segments. partialChain captures only the
 *       in-flight intended_text (one entry, not three).
 *   (3) speak() called after killActive() spawns a fresh ctx
 *       immediately. Queue was cleared by the kill, so the new call
 *       starts a new drain.
 *   (4) Two speak() calls separated by a killActive() barge: the
 *       first ctx is cancelled, the second is a fresh queue entry,
 *       no overlap.
 */
import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  createSpeakController,
  type SpeakControllerState,
  type SynthLikeHandle,
} from '../src/voice/lex-voice-speak-controller.js';

interface FakeHandle extends SynthLikeHandle {
  pcm: PassThrough;
  cancel: ReturnType<typeof vi.fn>;
  /** Resolver for the `done` promise. */
  resolveDone: () => void;
  /** True after the PassThrough emits 'end'. */
  ended: boolean;
}

function makeHandle(): FakeHandle {
  const pcm = new PassThrough();
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const handle: FakeHandle = {
    pcm,
    cancel: vi.fn(),
    done,
    sampleRate: 16000,
    resolveDone,
    ended: false,
  };
  pcm.on('end', () => {
    handle.ended = true;
  });
  return handle;
}

function freshState(): SpeakControllerState {
  return {
    ttsActive: null,
    currentTtsText: null,
    currentTtsStartedAtMs: 0,
    partialChain: [],
    ttsQueue: [],
    ttsQueueRunning: false,
  };
}

interface Bundle {
  state: SpeakControllerState;
  ctrl: ReturnType<typeof createSpeakController>;
  synthCalls: string[];
  handles: FakeHandle[];
  sentFrames: Array<Record<string, unknown>>;
  binaryChunks: Buffer[];
}

function makeBundle(): Bundle {
  const synthCalls: string[] = [];
  const handles: FakeHandle[] = [];
  const sentFrames: Array<Record<string, unknown>> = [];
  const binaryChunks: Buffer[] = [];
  const state = freshState();
  const ctrl = createSpeakController(state, {
    synthesize: (text: string): SynthLikeHandle => {
      synthCalls.push(text);
      const h = makeHandle();
      handles.push(h);
      return h;
    },
    send: (frame) => sentFrames.push(frame),
    sendBinary: (buf) => binaryChunks.push(buf),
  });
  return { state, ctrl, synthCalls, handles, sentFrames, binaryChunks };
}

/* Microtask flush — vitest does not return to event loop between
 * promise-chained awaits unless we yield explicitly. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('speak-queue controller (Fix 40)', () => {
  it('(1) same-turn: two speak() calls produce sequential piper spawns, ctx1 not cancelled', async () => {
    const { ctrl, synthCalls, handles, state } = makeBundle();
    ctrl.speak('first segment');
    ctrl.speak('second segment');
    await flush();
    /* Only the first segment is mid-flight; the second is queued. */
    expect(synthCalls).toEqual(['first segment']);
    expect(state.ttsQueue.length).toBe(1);
    expect(state.ttsActive).not.toBeNull();
    /* Drain ctx1 with a natural end. */
    handles[0]!.pcm.end();
    handles[0]!.resolveDone();
    await flush();
    /* ctx1 finished without cancellation; ctx2 spawned. */
    expect(handles[0]!.cancel).not.toHaveBeenCalled();
    expect(synthCalls).toEqual(['first segment', 'second segment']);
    /* Same-turn natural completion did NOT record a partialChain
     * entry — that is contract point (c). */
    expect(state.partialChain).toEqual([]);
    /* Drain ctx2 to keep the test deterministic. */
    handles[1]!.pcm.end();
    handles[1]!.resolveDone();
    await flush();
    expect(state.ttsActive).toBeNull();
    expect(state.ttsQueueRunning).toBe(false);
    expect(state.partialChain).toEqual([]);
  });

  it('(2) killActive mid-queue cancels in-flight + drops queued segments + partialChain has ONE entry', async () => {
    const { ctrl, synthCalls, handles, state } = makeBundle();
    ctrl.speak('first');
    ctrl.speak('second');
    ctrl.speak('third');
    await flush();
    expect(synthCalls).toEqual(['first']);
    expect(state.ttsQueue.length).toBe(2);
    /* Barge. */
    const cancelled = ctrl.killActive();
    expect(cancelled).toBe(true);
    expect(handles[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(state.ttsActive).toBeNull();
    expect(state.ttsQueue).toEqual([]);
    /* partialChain captures the in-flight intended_text ONLY; the
     * queued segments never made it to piper and have no audible
     * "intended" component to weave back in. */
    expect(state.partialChain).toHaveLength(1);
    expect(state.partialChain[0]!.intended_text).toBe('first');
    /* Even if the cancelled stream ends late, no further synth
     * spawns. */
    handles[0]!.pcm.end();
    handles[0]!.resolveDone();
    await flush();
    expect(synthCalls).toEqual(['first']);
  });

  it('(3) speak() after killActive starts a fresh ctx immediately', async () => {
    const { ctrl, synthCalls, handles, state } = makeBundle();
    ctrl.speak('reply A');
    await flush();
    expect(synthCalls).toEqual(['reply A']);
    ctrl.killActive();
    /* Resolve the cancelled stream so the queue runner unwinds. */
    handles[0]!.pcm.end();
    handles[0]!.resolveDone();
    await flush();
    expect(state.ttsActive).toBeNull();
    expect(state.ttsQueueRunning).toBe(false);
    /* New speak() lands on an empty queue. */
    ctrl.speak('reply B');
    await flush();
    expect(synthCalls).toEqual(['reply A', 'reply B']);
    expect(state.ttsActive).not.toBeNull();
    handles[1]!.pcm.end();
    handles[1]!.resolveDone();
    await flush();
  });

  it('(4) speak/kill/speak: no overlap, second is fresh queue entry', async () => {
    const { ctrl, synthCalls, handles, state } = makeBundle();
    ctrl.speak('A');
    await flush();
    expect(synthCalls).toEqual(['A']);
    ctrl.killActive();
    expect(handles[0]!.cancel).toHaveBeenCalledTimes(1);
    /* Even before the cancelled stream's natural end, queuing B
     * stages it on an empty queue (the kill cleared everything). */
    ctrl.speak('B');
    /* Drain the cancelled A so the runQueue loop can pick up B.
     * Production piper.cancel kills the child and the FD closes
     * shortly after; we simulate by ending the PassThrough. */
    handles[0]!.pcm.end();
    handles[0]!.resolveDone();
    await flush();
    expect(synthCalls).toEqual(['A', 'B']);
    expect(handles[1]!.cancel).not.toHaveBeenCalled();
    /* partialChain has exactly the cancelled A. */
    expect(state.partialChain.map((e) => e.intended_text)).toEqual(['A']);
    handles[1]!.pcm.end();
    handles[1]!.resolveDone();
    await flush();
  });

  it('killActive returns false when nothing is in flight (idle-state barge)', () => {
    const { ctrl, state } = makeBundle();
    const cancelled = ctrl.killActive();
    expect(cancelled).toBe(false);
    expect(state.partialChain).toEqual([]);
  });

  it('killActive clears queue even when there is no in-flight ctx', async () => {
    /* Defensive: a queued-but-not-yet-running segment must drop on
     * a barge so it cannot replay after the user redirects. */
    const { ctrl, state } = makeBundle();
    /* Force a queue entry without starting the runner. */
    state.ttsQueue.push({ cleanText: 'orphaned' });
    expect(state.ttsQueue.length).toBe(1);
    const cancelled = ctrl.killActive();
    /* No ctx was in flight, so killActive reports false. But the
     * queue was still cleared. */
    expect(cancelled).toBe(false);
    expect(state.ttsQueue).toEqual([]);
  });
});
