/**
 * Browser binding for the playback queue: one persistent
 * HTMLAudioElement + blob URLs. This is the media-element path the
 * echo canceller actually references (VOICE-TOP-LAYER-SPEC.md, "Echo,
 * first line"); the old AudioContext buffer-source scheduler was
 * invisible to AEC (Chromium bug 40504498).
 *
 * NOT unit-tested (thin DOM wrapper); the queue logic it binds is
 * fully pinned in tests/voice-engine-playback-queue.test.ts against
 * injected fakes, per the repo's stub-injection idiom.
 */
import {
  createPlaybackQueue,
  type AudioLike,
  type PlaybackQueue,
  type PlaybackQueueCallbacks,
} from "./playback-queue";

export interface BrowserPlaybackSink extends PlaybackQueue {
  /** Route the element to an output device (setSinkId), best-effort. */
  applySinkId(deviceId: string): Promise<boolean>;
  /** Play a beat of silence NOW, inside a user-gesture call stack, so
   * the element earns gesture-blessed playback and later play() calls
   * from network callbacks cannot be rejected by the autoplay policy.
   * Best-effort: resolves true when the prime played, false when the
   * browser refused (in which case the retry-on-gesture path in the
   * queue is the fallback). */
  primeFromGesture(): Promise<boolean>;
}

/* 100ms of 16kHz mono int16 silence wrapped as a WAV, tiny enough to
 * inline. Built lazily once; used only by primeFromGesture. */
function silentWavBytes(): Uint8Array {
  const samples = 1600;
  const dataLen = samples * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, dataLen, true);
  return new Uint8Array(buf);
}

export function createBrowserPlaybackSink(
  cb: PlaybackQueueCallbacks = {},
): BrowserPlaybackSink {
  const el = new Audio();
  el.preload = "auto";
  /* Adapter: DOM onended carries an Event arg the queue never needs;
   * delegate through a plain object so the AudioLike contract stays
   * argument-free. */
  const adapted: AudioLike = {
    get src() {
      return el.src;
    },
    set src(v: string) {
      el.src = v;
    },
    get currentTime() {
      return el.currentTime;
    },
    set currentTime(v: number) {
      el.currentTime = v;
    },
    onended: null,
    play: () => el.play(),
    pause: () => el.pause(),
  };
  el.onended = () => adapted.onended?.();
  const queue = createPlaybackQueue(
    {
      createAudio: () => adapted,
      createObjectUrl: (bytes) =>
        URL.createObjectURL(
          new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" }),
        ),
      revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    },
    cb,
  );
  return {
    ...queue,
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
    async primeFromGesture(): Promise<boolean> {
      /* Never prime over live playback; the element already has the
       * blessing if it is playing. */
      if (!el.paused) return true;
      const url = URL.createObjectURL(
        new Blob([silentWavBytes().buffer as ArrayBuffer], {
          type: "audio/wav",
        }),
      );
      try {
        el.src = url;
        await el.play();
        el.pause();
        el.removeAttribute("src");
        return true;
      } catch {
        return false;
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}
