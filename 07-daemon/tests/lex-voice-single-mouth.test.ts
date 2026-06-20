/**
 * Single mouth across sources (pillar 3.1, sliver V1), flag ON.
 *
 * Two speak controllers = two sources (e.g. Lex reply + heartbeat). With
 * DEVNEURAL_VOICE_HAIKU=1 only one may have a live TTS stream at a time:
 * while source A is mid-stream, source B's segment cannot reach
 * synthesize() - it defers until A releases the mouth. Two PCM streams to
 * the client are therefore structurally impossible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  createSpeakController,
  type SpeakControllerState,
  type SynthLikeHandle,
} from '../src/voice/lex-voice-speak-controller.js';
import { _resetMouth } from '../src/voice/voice-mouth.js';

interface FakeHandle extends SynthLikeHandle {
  pcm: PassThrough;
  cancel: ReturnType<typeof vi.fn>;
  resolveDone: () => void;
}

function makeHandle(): FakeHandle {
  const pcm = new PassThrough();
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return { pcm, cancel: vi.fn(), done, sampleRate: 16000, resolveDone };
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

function makeSource(ownerId: string) {
  const synthCalls: string[] = [];
  const handles: FakeHandle[] = [];
  const state = freshState();
  const ctrl = createSpeakController(state, {
    mouthOwnerId: ownerId,
    synthesize: (text: string): SynthLikeHandle => {
      synthCalls.push(text);
      const h = makeHandle();
      handles.push(h);
      return h;
    },
    send: () => undefined,
    sendBinary: () => undefined,
  });
  return { ctrl, state, synthCalls, handles };
}

async function flush(realMs = 0): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
  if (realMs > 0) await new Promise<void>((r) => setTimeout(r, realMs));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
}

let prior: string | undefined;

beforeEach(() => {
  prior = process.env.DEVNEURAL_VOICE_HAIKU;
  process.env.DEVNEURAL_VOICE_HAIKU = '1';
  _resetMouth();
});

afterEach(() => {
  if (prior === undefined) delete process.env.DEVNEURAL_VOICE_HAIKU;
  else process.env.DEVNEURAL_VOICE_HAIKU = prior;
  _resetMouth();
});

describe('single mouth across two sources (flag ON)', () => {
  it('source B cannot start a stream while source A holds the mouth', async () => {
    const a = makeSource('A');
    const b = makeSource('B');

    a.ctrl.speak('alpha');
    await flush();
    /* A holds the mouth and is mid-stream. */
    expect(a.synthCalls).toEqual(['alpha']);
    expect(a.state.ttsActive).not.toBeNull();

    b.ctrl.speak('beta');
    await flush(40);
    /* B is blocked by the single mouth: it has NOT synthesized, and its
     * segment is parked on its own queue, not lost. */
    expect(b.synthCalls).toEqual([]);
    expect(b.state.ttsQueue.length).toBe(1);

    /* A finishes -> releases the mouth. */
    a.handles[0]!.pcm.end();
    a.handles[0]!.resolveDone();
    await flush(60);

    /* Now B can take the mouth and speak. */
    expect(b.synthCalls).toEqual(['beta']);
    b.handles[0]!.pcm.end();
    b.handles[0]!.resolveDone();
    await flush(40);
    /* Never two live streams at once: A was done before B started. */
    expect(a.state.ttsActive).toBeNull();
  });
});
