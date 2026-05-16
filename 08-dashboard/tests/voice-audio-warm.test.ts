/* Regression test for the "first reply silent on a fresh Lex
 * session" bug.
 *
 * The bug: AudioContext was created lazily inside the tts-start WS
 * message handler. iOS Safari and strict Chromium autoplay policies
 * require AudioContext creation + resume() to live inside a
 * user-gesture handler. Network callbacks do not count, so the
 * first reply's PCM chunks were scheduled into a half-suspended
 * context whose clock never advanced. Second and later replies
 * worked because by then unrelated state churn had committed the
 * clock.
 *
 * The fix: warmAudioContext is called inside the "start voice"
 * click handler. It creates the context, kicks off resume(), and
 * plays a silent 1-frame buffer so the gesture commits.
 *
 * These tests pin the contract: warmAudioContext produces a usable
 * context, the silent buffer is scheduled, and the downstream
 * scheduling path (replicating VoiceClient's inline
 * schedulePcmChunk) produces a BufferSourceNode.start() call no
 * matter which order tts-start, ctx-resume, and PCM chunks arrive
 * in.
 */
import { describe, expect, it, vi } from 'vitest';
import { warmAudioContext } from '../lib/voice-audio-warm';

/* Stub builders.
 *
 * The DOM AudioContext / AudioBufferSourceNode types are not
 * available in jsdom; we drive the API surface the production code
 * actually touches and cast as the matching DOM type at the
 * boundary. */
interface FakeBufferSource {
  buffer: unknown;
  started: boolean;
  startCalls: number[];
  start: (when: number) => void;
  connect: () => void;
  disconnect: () => void;
  onended: (() => void) | null;
}

interface FakeAudioContext {
  sampleRate: number;
  state: AudioContextState;
  currentTime: number;
  destination: object;
  resumeCalls: number;
  createdBuffers: Array<{ channels: number; length: number; rate: number }>;
  createdSources: FakeBufferSource[];
  resume: () => Promise<void>;
  createBuffer: (channels: number, length: number, rate: number) => unknown;
  createBufferSource: () => FakeBufferSource;
  close: () => Promise<void>;
  __advanceToRunning: () => void;
}

function makeFakeAudioContext(opts: { rate?: number; startSuspended?: boolean } = {}): FakeAudioContext {
  const rate = opts.rate ?? 48000;
  const ctx: FakeAudioContext = {
    sampleRate: rate,
    state: opts.startSuspended === false ? 'running' : 'suspended',
    currentTime: 0,
    destination: { __destination: true },
    resumeCalls: 0,
    createdBuffers: [],
    createdSources: [],
    resume: vi.fn(async () => {
      ctx.resumeCalls += 1;
      ctx.state = 'running';
    }) as unknown as () => Promise<void>,
    createBuffer: (channels, length, r) => {
      ctx.createdBuffers.push({ channels, length, rate: r });
      return { channels, length, sampleRate: r };
    },
    createBufferSource: () => {
      const src: FakeBufferSource = {
        buffer: null,
        started: false,
        startCalls: [],
        start: (when: number) => {
          src.started = true;
          src.startCalls.push(when);
        },
        connect: () => undefined,
        disconnect: () => undefined,
        onended: null,
      };
      ctx.createdSources.push(src);
      return src;
    },
    close: async () => {
      ctx.state = 'closed';
    },
    __advanceToRunning: () => {
      ctx.state = 'running';
      ctx.currentTime = 1.0;
    },
  };
  return ctx;
}

function makeFakeCtor(
  rate: number,
): { Ctor: typeof AudioContext; lastInstance: { current: FakeAudioContext | null } } {
  const slot = { current: null as FakeAudioContext | null };
  const Ctor = vi.fn((options?: { sampleRate?: number }) => {
    const ctx = makeFakeAudioContext({ rate: options?.sampleRate ?? rate });
    slot.current = ctx;
    return ctx;
  }) as unknown as typeof AudioContext;
  return { Ctor, lastInstance: slot };
}

/* Local replica of VoiceClient's schedulePcmChunk so the test can
 * drive the exact scheduling behaviour without standing up the
 * whole component. Mirrors VoiceClient.tsx:1046-1083 closely. */
function schedulePcmChunk(
  ctx: FakeAudioContext,
  pcm: ArrayBuffer,
  ttsRate: number,
  playheadRef: { current: number },
  speakingRef: { current: boolean },
): FakeBufferSource | null {
  if (!speakingRef.current) return null;
  const int16 = new Int16Array(pcm);
  const float = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float[i] = (int16[i] ?? 0) / 0x8000;
  }
  const buffer = ctx.createBuffer(1, float.length, ttsRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect();
  if (playheadRef.current < ctx.currentTime + 0.05) {
    playheadRef.current = ctx.currentTime + 0.05;
  }
  src.start(playheadRef.current);
  playheadRef.current += float.length / ttsRate;
  return src;
}

describe('warmAudioContext', () => {
  it('creates a context inside the gesture handler', () => {
    const { Ctor, lastInstance } = makeFakeCtor(48000);
    const ctx = warmAudioContext({ AudioContextCtor: Ctor });
    expect(ctx).not.toBeNull();
    expect(lastInstance.current).not.toBeNull();
  });

  it('kicks off resume on a suspended context', () => {
    const { Ctor, lastInstance } = makeFakeCtor(48000);
    warmAudioContext({ AudioContextCtor: Ctor });
    expect(lastInstance.current!.resumeCalls).toBeGreaterThanOrEqual(1);
  });

  it('plays a silent 1-frame buffer to commit the gesture', () => {
    const { Ctor, lastInstance } = makeFakeCtor(48000);
    warmAudioContext({ AudioContextCtor: Ctor });
    const ctx = lastInstance.current!;
    expect(ctx.createdBuffers).toHaveLength(1);
    expect(ctx.createdBuffers[0]).toMatchObject({ channels: 1, length: 1, rate: 48000 });
    expect(ctx.createdSources).toHaveLength(1);
    expect(ctx.createdSources[0]!.started).toBe(true);
    expect(ctx.createdSources[0]!.startCalls[0]).toBe(0);
  });

  it('falls back to webkitAudioContext when AudioContext is missing', () => {
    const { Ctor: WebkitCtor, lastInstance } = makeFakeCtor(44100);
    const ctx = warmAudioContext({
      AudioContextCtor: undefined,
      WebkitAudioContextCtor: WebkitCtor,
    });
    expect(ctx).not.toBeNull();
    expect(lastInstance.current).not.toBeNull();
  });

  it('returns null when no constructor is available', () => {
    expect(
      warmAudioContext({
        AudioContextCtor: undefined,
        WebkitAudioContextCtor: undefined,
      }),
    ).toBeNull();
  });

  it('does not throw if createBuffer fails', () => {
    const ctx = makeFakeAudioContext({ rate: 48000 });
    ctx.createBuffer = () => {
      throw new Error('CTOR_FAIL');
    };
    const Ctor = vi.fn(() => ctx) as unknown as typeof AudioContext;
    expect(() => warmAudioContext({ AudioContextCtor: Ctor })).not.toThrow();
  });
});

describe('first-reply playback under adversarial timing', () => {
  /* The user-facing contract: the first reply must produce a real
   * BufferSourceNode.start() call regardless of the order in which
   * tts-start, ctx-resume, and PCM chunks arrive after the user has
   * clicked "start voice". The warm step happens synchronously in
   * the gesture; ctx-resume is a Promise that may resolve at any
   * point after. tts-start flips speakingRef. PCM chunks invoke
   * schedulePcmChunk. */

  function runScenario(steps: Array<'resume' | 'tts-start' | 'pcm'>): {
    chunksPlayed: number;
    chunksDropped: number;
  } {
    const { Ctor, lastInstance } = makeFakeCtor(48000);
    warmAudioContext({ AudioContextCtor: Ctor });
    const ctx = lastInstance.current!;
    /* Reset the silent-warm buffer's scheduler state so the test
     * only counts the PCM chunks we drive. */
    ctx.createdSources.length = 0;
    const playheadRef = { current: 0 };
    const speakingRef = { current: false };
    const ttsRate = 22050;
    const pcm = new Int16Array([0, 1, 2, 3]).buffer;
    let chunksPlayed = 0;
    let chunksDropped = 0;

    for (const step of steps) {
      switch (step) {
        case 'resume':
          /* Simulate the async resume completing. */
          ctx.__advanceToRunning();
          break;
        case 'tts-start':
          /* Same body as VoiceClient.tsx tts-start handler now that
           * the lazy-create branch is gone. */
          if (ctx.state === 'suspended') {
            void (ctx.resume() as unknown as Promise<void>).catch(() => undefined);
          }
          playheadRef.current = ctx.currentTime;
          speakingRef.current = true;
          break;
        case 'pcm': {
          const src = schedulePcmChunk(
            ctx,
            pcm,
            ttsRate,
            playheadRef,
            speakingRef,
          );
          if (src && src.started) chunksPlayed += 1;
          else chunksDropped += 1;
          break;
        }
      }
    }
    return { chunksPlayed, chunksDropped };
  }

  it('plays every chunk that arrives after tts-start (canonical order)', () => {
    const r = runScenario(['tts-start', 'resume', 'pcm', 'pcm', 'pcm']);
    expect(r.chunksPlayed).toBe(3);
    expect(r.chunksDropped).toBe(0);
  });

  it('plays every chunk even when resume completes BEFORE tts-start', () => {
    const r = runScenario(['resume', 'tts-start', 'pcm', 'pcm']);
    expect(r.chunksPlayed).toBe(2);
    expect(r.chunksDropped).toBe(0);
  });

  it('plays every chunk even when resume completes AFTER chunks scheduled', () => {
    /* The pre-fix iOS bug: chunks landed against a suspended ctx
     * whose clock never advanced. With warmAudioContext, the
     * gesture is committed; even though state may still read
     * suspended at schedule time, source.start(time) is still
     * called and fires once the resume catches up. */
    const r = runScenario(['tts-start', 'pcm', 'pcm', 'resume']);
    expect(r.chunksPlayed).toBe(2);
    expect(r.chunksDropped).toBe(0);
  });

  it('drops chunks that arrive BEFORE tts-start by design (gating)', () => {
    /* PCM before tts-start is intentionally dropped via the
     * speakingRef gate; otherwise a stale buffered chunk from the
     * previous reply would bleed into the next. Tests the negative
     * path. */
    const r = runScenario(['pcm', 'tts-start', 'pcm', 'pcm']);
    expect(r.chunksPlayed).toBe(2);
    expect(r.chunksDropped).toBe(1);
  });
});
