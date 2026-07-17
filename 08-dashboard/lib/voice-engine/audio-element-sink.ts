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
  };
}
