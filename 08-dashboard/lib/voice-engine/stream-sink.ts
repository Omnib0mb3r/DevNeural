/**
 * Continuous stream sink (BUG-032): one output stream per reply instead
 * of one media-element load per sentence.
 *
 * The daemon frames every sentence as tts-start, raw int16 PCM chunks,
 * tts-end. The old playback queue assembled each sentence into a WAV
 * blob and played it only once it was complete, chaining sentences on
 * the element's onended. On a slow or jittery link that meant a gap
 * before every sentence (transfer time exceeding the previous
 * sentence's play time) and, because the element stopped and restarted
 * per sentence, Bluetooth car audio clipped the first syllable of each.
 *
 * Here every chunk is decoded the moment it arrives and scheduled as an
 * AudioBufferSourceNode at max(playhead, now + lead). The first chunk
 * of a run therefore starts playing lead ms after it lands, never after
 * the sentence closes. The lead starts at 60ms and grows by 40ms on
 * each measured underrun (a chunk that arrives after the playhead has
 * already passed) up to 400ms, and decays by 10ms per clean segment, so
 * buffering is only ever added in response to a measured shortfall. A
 * segment end pads 120ms of silence so the stream carries straight into
 * the next sentence without the element ever stopping.
 *
 * Pure logic over an injected AudioContext-like, destination node and
 * gain-like; audio-stream-sink.ts binds the real graph in the browser
 * (a GainNode into a MediaStreamAudioDestinationNode whose stream is the
 * srcObject of one HTMLAudioElement, so Chrome's echo canceller still
 * references what the speakers play; Chromium bug 40504498).
 *
 * Interrupt contract is unchanged from playback-queue.ts: cancelAll()
 * stops every scheduled source instantly, drops any chunk still in
 * flight through a generation bump, and returns the milliseconds of
 * audio actually consumed (padding excluded) so the daemon can truncate
 * conversational context to the words the operator heard.
 */
import type {
  CancelResult,
  PlaybackQueue,
  PlaybackQueueCallbacks,
} from "./playback-queue";

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
}

export interface SourceLike {
  buffer: AudioBufferLike | null;
  onended: ((ev: Event) => void) | null;
  connect(destination: AudioNodeLike): unknown;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): SourceLike;
}

export interface GainLike {
  gain: { value: number };
}

export interface StreamSinkDeps {
  ctx: AudioContextLike;
  /** Where every source connects: the gain node in the browser. */
  destination: AudioNodeLike;
  gain: GainLike;
}

export interface StreamSinkOptions {
  /** Initial and minimum scheduling lead, ms. */
  leadMs?: number;
  /** Lead growth per underrun, ms. */
  leadStepMs?: number;
  /** Ceiling for the lead, ms. */
  maxLeadMs?: number;
  /** Lead decay per clean segment, ms. */
  leadDecayMs?: number;
  /** Silence padded after every segment, ms. */
  gapMs?: number;
}

export interface StreamSink extends PlaybackQueue {
  /** Output level, clamped to MIN_GAIN .. MAX_GAIN. */
  setGain(gain: number): void;
  /** Current scheduling lead, ms (diagnostic). */
  leadMs(): number;
}

export const DEFAULT_LEAD_MS = 60;
export const LEAD_STEP_MS = 40;
export const MAX_LEAD_MS = 400;
export const LEAD_DECAY_MS = 10;
export const GAP_MS = 120;
export const MIN_GAIN = 0.2;
export const MAX_GAIN = 1;

const FALLBACK_SAMPLE_RATE = 22_050;

/** int16 little-endian bytes to float32 in -1 .. 1. A trailing odd byte
 * is dropped. */
export function int16ToFloat32(bytes: Uint8Array): Float32Array {
  const n = bytes.byteLength >> 1;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) {
    out[i] = view.getInt16(i * 2, true) / 32_768;
  }
  return out;
}

interface Scheduled {
  src: SourceLike;
  startAt: number;
  durationS: number;
  padding: boolean;
  gen: number;
}

interface Segment {
  sampleRate: number;
  gen: number;
  chunks: number;
  underrun: boolean;
}

export function createStreamSink(
  deps: StreamSinkDeps,
  cb: PlaybackQueueCallbacks = {},
  opts: StreamSinkOptions = {},
): StreamSink {
  const leadFloorMs = opts.leadMs ?? DEFAULT_LEAD_MS;
  const leadStepMs = opts.leadStepMs ?? LEAD_STEP_MS;
  const maxLeadMs = opts.maxLeadMs ?? MAX_LEAD_MS;
  const leadDecayMs = opts.leadDecayMs ?? LEAD_DECAY_MS;
  const gapMs = opts.gapMs ?? GAP_MS;

  let leadMs = leadFloorMs;
  /* Context time at which the next chunk may start; 0 when idle. */
  let playhead = 0;
  /* Generation guard: cancelAll bumps it so a chunk or end frame that
   * was mid-flight when the operator barged can never schedule. */
  let gen = 0;
  let segment: Segment | null = null;
  /* A run spans the first scheduled chunk to the drain or cancel. */
  let runActive = false;
  /* Audio (not padding) fully played in this run, ms. */
  let playedFullMs = 0;
  const active: Scheduled[] = [];

  const now = (): number => deps.ctx.currentTime;

  function inFlightMs(t: number): number {
    let ms = 0;
    for (const e of active) {
      if (e.padding) continue;
      const consumed = Math.min(Math.max(t - e.startAt, 0), e.durationS);
      ms += consumed * 1_000;
    }
    return ms;
  }

  function maybeDrain(): void {
    if (!runActive || segment !== null || active.length > 0) return;
    runActive = false;
    playhead = 0;
    cb.onDrained?.();
  }

  function onSourceEnded(entry: Scheduled): void {
    if (entry.gen !== gen) return;
    const i = active.indexOf(entry);
    if (i < 0) return;
    active.splice(i, 1);
    if (!entry.padding) playedFullMs += entry.durationS * 1_000;
    maybeDrain();
  }

  function schedule(
    buffer: AudioBufferLike,
    durationS: number,
    startAt: number,
    padding: boolean,
  ): void {
    const src = deps.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(deps.destination);
    const entry: Scheduled = { src, startAt, durationS, padding, gen };
    active.push(entry);
    src.onended = () => onSourceEnded(entry);
    src.start(startAt);
    playhead = startAt + durationS;
  }

  return {
    beginSegment(sampleRate: number): void {
      const rate =
        Number.isFinite(sampleRate) && sampleRate > 0
          ? sampleRate
          : FALLBACK_SAMPLE_RATE;
      segment = { sampleRate: rate, gen, chunks: 0, underrun: false };
    },

    appendPcm(bytes: Uint8Array): void {
      const seg = segment;
      if (!seg || seg.gen !== gen) return;
      const samples = int16ToFloat32(bytes);
      if (samples.length === 0) return;
      const t = now();
      /* Underrun: the audio ran dry before this chunk landed. Buy more
       * lead for every later chunk; the segment forgoes its decay. */
      if (runActive && t > playhead) {
        leadMs = Math.min(maxLeadMs, leadMs + leadStepMs);
        seg.underrun = true;
      }
      const startAt = Math.max(playhead, t + leadMs / 1_000);
      const buffer = deps.ctx.createBuffer(1, samples.length, seg.sampleRate);
      buffer.getChannelData(0).set(samples);
      const startedRun = !runActive;
      if (startedRun) {
        runActive = true;
        playedFullMs = 0;
      }
      schedule(buffer, samples.length / seg.sampleRate, startAt, false);
      seg.chunks += 1;
      if (startedRun) cb.onPlaybackStart?.();
    },

    endSegment(): void {
      const seg = segment;
      segment = null;
      if (!seg || seg.gen !== gen) return;
      if (seg.chunks === 0) {
        /* Nothing was scheduled for it; it must not hold the drain. */
        maybeDrain();
        return;
      }
      if (!seg.underrun) leadMs = Math.max(leadFloorMs, leadMs - leadDecayMs);
      /* Silence between sentences, as a real source: the stream never
       * stops, and its onended is the drain trigger even when the
       * sentence's audio had already run dry before tts-end landed. */
      const length = Math.max(1, Math.round((gapMs / 1_000) * seg.sampleRate));
      const buffer = deps.ctx.createBuffer(1, length, seg.sampleRate);
      schedule(buffer, length / seg.sampleRate, Math.max(playhead, now()), true);
    },

    cancelAll(): CancelResult {
      gen += 1;
      segment = null;
      const playedMs = playedFullMs + inFlightMs(now());
      for (const e of active) {
        e.src.onended = null;
        try {
          e.src.stop();
        } catch {
          /* never started, or the context is already closed */
        }
      }
      active.length = 0;
      runActive = false;
      playhead = 0;
      playedFullMs = 0;
      return { playedMs };
    },

    isActive(): boolean {
      return runActive;
    },

    playedMsSoFar(): number {
      return playedFullMs + inFlightMs(now());
    },

    setGain(gain: number): void {
      if (!Number.isFinite(gain)) return;
      deps.gain.gain.value = Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain));
    },

    leadMs(): number {
      return leadMs;
    },
  };
}
