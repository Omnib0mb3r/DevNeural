/**
 * Speak-controller live-render hook (DRIVE-QUEUE 1b). Pins: a render:true
 * segment is synthesized from the restyled text; a default segment is
 * never rendered; and a barge (killActive) mid-render DROPS the segment
 * instead of speaking stale content after the barge.
 */
import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  createSpeakController,
  type SpeakControllerState,
  type SpeakControllerDeps,
  type SynthLikeHandle,
} from '../src/voice/lex-voice-speak-controller.js';

function makeHandle(): SynthLikeHandle {
  const pcm = new PassThrough();
  return {
    pcm,
    cancel: vi.fn(),
    done: Promise.resolve(),
    sampleRate: 16000,
  };
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

function makeBundle(renderSegment?: SpeakControllerDeps['renderSegment']) {
  const synthCalls: string[] = [];
  const state = freshState();
  const ctrl = createSpeakController(state, {
    synthesize: (text: string): SynthLikeHandle => {
      synthCalls.push(text);
      const h = makeHandle();
      /* End the stream on the next tick so the drain loop advances. */
      setImmediate(() => (h.pcm as PassThrough).end());
      return h;
    },
    send: () => undefined,
    sendBinary: () => undefined,
    ...(renderSegment ? { renderSegment } : {}),
  });
  return { ctrl, state, synthCalls };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('speak controller live render (DRIVE-QUEUE 1b)', () => {
  it('synthesizes the restyled text for a render:true segment', async () => {
    const { ctrl, synthCalls } = makeBundle(async (t) =>
      t.replace('raw', 'warm'),
    );
    ctrl.speak('raw body', { render: true });
    await flush();
    expect(synthCalls).toEqual(['warm body']);
  });

  it('does NOT render a default (ack/glue) segment', async () => {
    const renderSegment = vi.fn(async (t: string) => `warmed ${t}`);
    const { ctrl, synthCalls } = makeBundle(renderSegment);
    ctrl.speak('plain ack');
    await flush();
    expect(synthCalls).toEqual(['plain ack']);
    expect(renderSegment).not.toHaveBeenCalled();
  });

  it('keeps the original text if the render returns empty', async () => {
    const { ctrl, synthCalls } = makeBundle(async () => '');
    ctrl.speak('keep me', { render: true });
    await flush();
    expect(synthCalls).toEqual(['keep me']);
  });

  it('drops a body segment barged mid-render (never speaks stale content)', async () => {
    let resolveRender: (s: string) => void = () => undefined;
    const { ctrl, synthCalls } = makeBundle(
      () =>
        new Promise<string>((res) => {
          resolveRender = res;
        }),
    );
    ctrl.speak('the stale answer', { render: true });
    await flush();
    /* Parked on the render await; nothing synthesized yet. */
    expect(synthCalls).toEqual([]);
    /* User barges. */
    ctrl.killActive();
    /* Render resolves AFTER the barge: must be discarded. */
    resolveRender('the stale answer, restyled');
    await flush();
    expect(synthCalls).toEqual([]);
  });
});
