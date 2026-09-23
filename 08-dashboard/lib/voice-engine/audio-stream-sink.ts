/**
 * Browser binding for the continuous stream sink (BUG-032).
 *
 * Graph: AudioBufferSourceNode (one per PCM chunk, scheduled by
 * stream-sink.ts) -> GainNode -> MediaStreamAudioDestinationNode, whose
 * stream is the srcObject of one persistent HTMLAudioElement. Playback
 * still leaves through a media element, so Chrome's echo canceller
 * references what the speakers play (Chromium bug 40504498, the reason
 * the 2026-07-17 engine cut moved off plain Web Audio output), but the
 * element now plays one live stream for the whole session instead of
 * loading a blob per sentence, which is what clipped sentence onsets on
 * Bluetooth car audio and left a gap before every sentence on a slow
 * link.
 *
 * Context ownership: the sink binds to the app's AudioContext when the
 * caller hands one over (VoiceClient's audioCtxRef, warmed inside the
 * start gesture) and rebinds whenever that context changes or closes
 * (voice-off closes it, the watchdog heal replaces it). Without a
 * caller context it owns one of its own.
 *
 * NOT unit-tested (thin DOM wrapper); the scheduling it binds is pinned
 * in tests/stream-sink.test.ts against injected fakes, per the repo's
 * stub-injection idiom.
 */
import type { CancelResult, PlaybackQueueCallbacks } from "./playback-queue";
import { createStreamSink, DEFAULT_LEAD_MS, MAX_GAIN, type StreamSink } from "./stream-sink";

export interface BrowserStreamSink extends StreamSink {
  /** Route the element to an output device (setSinkId), best-effort. */
  applySinkId(deviceId: string): Promise<boolean>;
  /** Bind the graph and start the element playing the live stream NOW,
   * inside a user-gesture call stack, so later scheduling from network
   * callbacks is never blocked by the autoplay policy. Resolves true
   * when the element is playing, false when the browser refused (the
   * retry-on-gesture path is the fallback). */
  primeFromGesture(): Promise<boolean>;
}

export interface BrowserStreamSinkOptions {
  /** The app's AudioContext, read on every bind. A live context carries
   * the graph (one context for the page); null or a closed one makes
   * the sink own a context of its own. */
  getContext?: () => AudioContext | null;
}

interface Graph {
  ctx: AudioContext;
  owned: boolean;
  gain: GainNode;
  dest: MediaStreamAudioDestinationNode;
  sched: StreamSink;
}

function newAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = win.AudioContext ?? win.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

export function createBrowserStreamSink(
  cb: PlaybackQueueCallbacks = {},
  opts: BrowserStreamSinkOptions = {},
): BrowserStreamSink {
  const el = new Audio();
  let graph: Graph | null = null;
  let lastGain = MAX_GAIN;
  let retryArmed = false;
  let reportedNoContext = false;

  function liveAppContext(): AudioContext | null {
    const ctx = opts.getContext?.() ?? null;
    return ctx && ctx.state !== "closed" ? ctx : null;
  }

  /** Bind the graph to the context that should carry it now; rebuilt
   * when that context changed. null when no AudioContext can be had. */
  function bind(): { graph: Graph; rebuilt: boolean } | null {
    const app = liveAppContext();
    const ownLive =
      graph && graph.owned && graph.ctx.state !== "closed" ? graph.ctx : null;
    const wanted = app ?? ownLive;
    if (graph && wanted && graph.ctx === wanted) {
      return { graph, rebuilt: false };
    }
    const ctx = wanted ?? newAudioContext();
    if (!ctx) {
      if (!reportedNoContext) {
        reportedNoContext = true;
        cb.onError?.(new Error("AudioContext unavailable"));
      }
      return null;
    }
    let next: Graph;
    try {
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      gain.connect(dest);
      const sched = createStreamSink({ ctx, destination: gain, gain }, cb);
      sched.setGain(lastGain);
      el.srcObject = dest.stream;
      next = { ctx, owned: ctx !== app, gain, dest, sched };
    } catch (err) {
      cb.onError?.(err);
      return null;
    }
    const old = graph;
    graph = next;
    if (old) {
      old.sched.cancelAll();
      try {
        old.gain.disconnect();
      } catch {
        /* context already closed */
      }
      if (old.owned && old.ctx !== ctx && old.ctx.state !== "closed") {
        void old.ctx.close().catch(() => undefined);
      }
    }
    if (ctx.state === "suspended") {
      try {
        void ctx.resume().catch(() => undefined);
      } catch {
        /* resume can throw synchronously on stale ctor shapes */
      }
    }
    return { graph: next, rebuilt: true };
  }

  /* Autoplay-block resilience (2026-07-18 silent-TTS fix, carried over
   * from playback-queue.ts): a NotAllowedError must not kill the run
   * silently. Retry play() on the next user gesture; the element keeps
   * its blessing from then on. */
  function armGestureRetry(err: unknown): void {
    if (retryArmed || typeof document === "undefined") return;
    if ((err as { name?: string } | undefined)?.name !== "NotAllowedError") return;
    retryArmed = true;
    const retry = (): void => {
      document.removeEventListener("pointerdown", retry);
      document.removeEventListener("keydown", retry);
      retryArmed = false;
      if (el.paused) void play();
    };
    document.addEventListener("pointerdown", retry, { once: true });
    document.addEventListener("keydown", retry, { once: true });
  }

  /** Start (or keep) the element playing the live stream. The stream is
   * continuous silence between replies, so this is idempotent and the
   * element never ends on its own. */
  function play(): Promise<boolean> {
    let pending: Promise<void> | undefined;
    try {
      pending = el.play();
    } catch (err) {
      cb.onError?.(err);
      armGestureRetry(err);
      return Promise.resolve(false);
    }
    return Promise.resolve(pending).then(
      () => true,
      (err: unknown) => {
        cb.onError?.(err);
        armGestureRetry(err);
        return false;
      },
    );
  }

  return {
    beginSegment(sampleRate: number): void {
      const bound = bind();
      if (!bound) return;
      if (bound.rebuilt || el.paused) void play();
      bound.graph.sched.beginSegment(sampleRate);
    },
    appendPcm(bytes: Uint8Array): void {
      graph?.sched.appendPcm(bytes);
    },
    endSegment(): void {
      graph?.sched.endSegment();
    },
    cancelAll(): CancelResult {
      return graph ? graph.sched.cancelAll() : { playedMs: 0 };
    },
    isActive(): boolean {
      return graph?.sched.isActive() ?? false;
    },
    playedMsSoFar(): number {
      return graph?.sched.playedMsSoFar() ?? 0;
    },
    setGain(gain: number): void {
      if (!Number.isFinite(gain)) return;
      lastGain = gain;
      graph?.sched.setGain(gain);
    },
    leadMs(): number {
      return graph?.sched.leadMs() ?? DEFAULT_LEAD_MS;
    },
    async applySinkId(deviceId: string): Promise<boolean> {
      const sinkable = el as HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>;
      };
      if (typeof sinkable.setSinkId !== "function") return false;
      try {
        await sinkable.setSinkId(deviceId);
        return true;
      } catch {
        return false;
      }
    },
    primeFromGesture(): Promise<boolean> {
      /* Everything here stays synchronous up to el.play() so the call
       * lands inside the gesture's call stack (iOS Safari counts that,
       * not a later microtask). bind() already kicked ctx.resume(). */
      const bound = bind();
      if (!bound) return Promise.resolve(false);
      if (!bound.rebuilt && !el.paused) return Promise.resolve(true);
      return play();
    },
  };
}
