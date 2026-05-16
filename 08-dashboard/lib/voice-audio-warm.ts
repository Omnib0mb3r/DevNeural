/**
 * Warm an AudioContext inside a user-gesture handler.
 *
 * The first-reply-silent bug on fresh Lex sessions had nothing to do
 * with the WebSocket. There is only one voice WS, and by the time the
 * user has spoken into it for the first time the socket has been open
 * for seconds (hello-ack has to land before the VAD even starts). The
 * actual gap was the AudioContext: it was created lazily inside the
 * tts-start handler, which is a network callback, not a user-gesture
 * handler. iOS Safari and increasingly strict Chromium autoplay
 * policies require AudioContext creation + resume() to live inside a
 * gesture-chain handler. Outside one, the context comes up in a
 * half-suspended state where the clock does not advance until some
 * later gesture nudges it, so the first chunks scheduled into it are
 * effectively dropped.
 *
 * warmAudioContext is meant to be called synchronously inside the
 * "start voice" click handler. It creates the context, kicks off a
 * resume(), and plays a single silent frame so the audio graph
 * actually commits. By the time the first PCM chunk arrives over the
 * WS, the context is live and chunks scheduled at the playhead play
 * on schedule.
 *
 * Pure module: caller passes the AudioContext constructor (defaults
 * pulled from window in production, stubs in tests). Returns null
 * when no constructor is available so the caller can degrade
 * gracefully on older browsers.
 */

export interface WarmAudioContextOptions {
  AudioContextCtor?: typeof AudioContext;
  /** Older Safari exposed webkitAudioContext only. */
  WebkitAudioContextCtor?: typeof AudioContext;
  /** Optional explicit sampleRate. Default lets the platform pick;
   * the daemon's PCM is auto-resampled by createBuffer(rate) at
   * schedule time so context rate is not load-bearing. */
  sampleRate?: number;
}

export function warmAudioContext(
  opts: WarmAudioContextOptions,
): AudioContext | null {
  const Ctor = opts.AudioContextCtor ?? opts.WebkitAudioContextCtor;
  if (!Ctor) return null;
  let ctx: AudioContext;
  try {
    ctx = opts.sampleRate
      ? new Ctor({ sampleRate: opts.sampleRate })
      : new Ctor();
  } catch {
    return null;
  }
  if (ctx.state === 'suspended') {
    try {
      void ctx.resume().catch(() => undefined);
    } catch {
      /* resume can throw synchronously on stale ctor shapes */
    }
  }
  /* Play a 1-frame silent buffer so iOS Safari actually commits the
   * gesture-bound clock. Without this the resume() promise resolves
   * but the context's internal clock stays stuck until the next
   * gesture. */
  try {
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* non-fatal; ctx is still usable for later scheduling */
  }
  return ctx;
}
