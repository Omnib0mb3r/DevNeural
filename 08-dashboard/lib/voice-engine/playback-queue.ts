/**
 * Media-element playback queue (VOICE-TOP-LAYER-SPEC.md, "Echo, first
 * line" + interrupt contract).
 *
 * Replaces the AudioContext buffer-source scheduler: Chromium's echo
 * canceller historically does not reference Web Audio output (bug
 * 40504498), so TTS played that way is invisible to AEC and comes back
 * in the mic. A media element (HTMLAudioElement) IS referenced. Each
 * TTS segment (tts-start .. chunks .. tts-end) is assembled into one
 * WAV blob and played through a single persistent element; segments
 * chain on `onended`.
 *
 * Interrupt contract: cancelAll() pauses the element INSTANTLY, drops
 * every queued segment, and returns the total played milliseconds
 * (fully-played segments plus the in-flight element position) so the
 * daemon can truncate conversational context to the words actually
 * heard. onDrained fires only when the LAST queued segment truly
 * finishes: this is the client's real end-of-audio, which the daemon
 * never had (its tts-end fires at synth-stream end, seconds early).
 *
 * Pure logic over an injected AudioLike; audio-element-sink.ts binds
 * the real element + URL.createObjectURL in the browser.
 */
import { pcmToWavBytes } from "./pcm-wav";

export interface AudioLike {
  src: string;
  currentTime: number;
  onended: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
}

export interface PlaybackQueueDeps {
  createAudio(): AudioLike;
  createObjectUrl(bytes: Uint8Array): string;
  revokeObjectUrl(url: string): void;
}

export interface PlaybackQueueCallbacks {
  /** First audio of a run actually started playing. */
  onPlaybackStart?: () => void;
  /** The last queued segment finished playing: true audio drain. */
  onDrained?: () => void;
  /** A segment failed to play (autoplay policy, decode error). */
  onError?: (err: unknown) => void;
}

interface QueuedSegment {
  url: string;
  durationMs: number;
}

export interface CancelResult {
  /** Milliseconds of audio the operator actually heard this run. */
  playedMs: number;
}

export interface PlaybackQueue {
  /** Open a new segment (tts-start). sampleRate rides the frame. */
  beginSegment(sampleRate: number): void;
  /** Append a raw PCM chunk to the open segment. */
  appendPcm(bytes: Uint8Array): void;
  /** Close the open segment (tts-end): wrap + enqueue + maybe play. */
  endSegment(): void;
  /** Instant stop: pause element, drop queue, report played ms. */
  cancelAll(): CancelResult;
  /** True while audio is playing or queued. */
  isActive(): boolean;
  /** Played ms of the current run so far (without cancelling). */
  playedMsSoFar(): number;
}

export function createPlaybackQueue(
  deps: PlaybackQueueDeps,
  cb: PlaybackQueueCallbacks = {},
): PlaybackQueue {
  const audio = deps.createAudio();
  const queue: QueuedSegment[] = [];
  let current: QueuedSegment | null = null;
  /* Segment under assembly. null = no open segment. */
  let assembling: { chunks: Uint8Array[]; sampleRate: number } | null = null;
  /* Generation guard: cancelAll bumps it so a stale endSegment (chunks
   * that were mid-flight when the user barged) can never enqueue. */
  let gen = 0;
  let assemblingGen = 0;
  /* Played-ms accounting for the current run. Reset when a run starts
   * from idle. */
  let playedFullMs = 0;
  let runActive = false;

  function playNext(): void {
    const next = queue.shift();
    if (!next) {
      current = null;
      if (runActive) {
        runActive = false;
        cb.onDrained?.();
      }
      return;
    }
    current = next;
    audio.src = next.url;
    audio.currentTime = 0;
    const startedRun = !runActive;
    runActive = true;
    void Promise.resolve(audio.play()).catch((err) => {
      cb.onError?.(err);
      /* Autoplay-block resilience (2026-07-18 silent-TTS fix): a
       * NotAllowedError here previously killed the whole run
       * silently - the queue never drained, the UI sat on
       * "speaking", and the reply was readable but never heard.
       * Retry the SAME item on the next user gesture; the element
       * keeps its gesture blessing from then on. */
      const name = (err as Error | undefined)?.name;
      if (name === "NotAllowedError" && typeof document !== "undefined") {
        const retry = (): void => {
          document.removeEventListener("pointerdown", retry);
          document.removeEventListener("keydown", retry);
          if (current === next) {
            void Promise.resolve(audio.play()).catch((e2) => {
              cb.onError?.(e2);
            });
          }
        };
        document.addEventListener("pointerdown", retry, { once: true });
        document.addEventListener("keydown", retry, { once: true });
      }
    });
    if (startedRun) cb.onPlaybackStart?.();
  }

  audio.onended = () => {
    if (current) {
      playedFullMs += current.durationMs;
      deps.revokeObjectUrl(current.url);
      current = null;
    }
    playNext();
  };

  return {
    beginSegment(sampleRate: number): void {
      assembling = { chunks: [], sampleRate };
      assemblingGen = gen;
    },
    appendPcm(bytes: Uint8Array): void {
      if (!assembling || assemblingGen !== gen) return;
      assembling.chunks.push(bytes);
    },
    endSegment(): void {
      if (!assembling || assemblingGen !== gen) {
        assembling = null;
        return;
      }
      const { chunks, sampleRate } = assembling;
      assembling = null;
      const dataBytes = chunks.reduce((s, c) => s + c.byteLength, 0);
      if (dataBytes === 0) return;
      const wav = pcmToWavBytes(chunks, sampleRate);
      const durationMs = (dataBytes / 2 / sampleRate) * 1_000;
      queue.push({ url: deps.createObjectUrl(wav), durationMs });
      if (!current) {
        if (queue.length === 1 && !runActive) playedFullMs = 0;
        playNext();
      }
    },
    cancelAll(): CancelResult {
      gen++;
      assembling = null;
      const inFlightMs = current ? audio.currentTime * 1_000 : 0;
      const playedMs = playedFullMs + inFlightMs;
      try {
        audio.pause();
      } catch {
        /* already paused */
      }
      if (current) {
        deps.revokeObjectUrl(current.url);
        current = null;
      }
      for (const q of queue) deps.revokeObjectUrl(q.url);
      queue.length = 0;
      runActive = false;
      playedFullMs = 0;
      return { playedMs };
    },
    isActive(): boolean {
      return runActive && (current !== null || queue.length > 0);
    },
    playedMsSoFar(): number {
      const inFlightMs = current ? audio.currentTime * 1_000 : 0;
      return playedFullMs + inFlightMs;
    },
  };
}
