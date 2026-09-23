import { describe, expect, it } from "vitest";
import {
  createStreamSink,
  DEFAULT_LEAD_MS,
  GAP_MS,
  LEAD_STEP_MS,
  MAX_LEAD_MS,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioNodeLike,
  type SourceLike,
  type StreamSinkDeps,
} from "@/lib/voice-engine/stream-sink";

/**
 * BUG-032: one continuous output stream per reply instead of one media
 * element load per sentence. The scheduler is pure logic over an
 * injected AudioContext-like so it runs in vitest without a DOM;
 * audio-stream-sink.ts binds the real context, gain node and
 * MediaStream destination in the browser.
 *
 * Pins: the first chunk is scheduled at now + lead (60ms) the moment it
 * arrives, never after the segment closes; a late chunk grows the lead
 * by 40ms up to 400ms and a clean segment decays it by 10ms; every
 * segment end pads 120ms of silence so the element never stops between
 * sentences; a three-segment reply starts once and drains once;
 * cancelAll stops everything and reports the audio actually consumed,
 * padding excluded; chunks after a cancel are dropped; setGain clamps.
 */

class FakeBuffer implements AudioBufferLike {
  readonly data: Float32Array;
  constructor(
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeSource implements SourceLike {
  buffer: AudioBufferLike | null = null;
  onended: ((ev: Event) => void) | null = null;
  connectedTo: AudioNodeLike | null = null;
  startAt: number | null = null;
  stopped = false;
  ended = false;
  connect(destination: AudioNodeLike): unknown {
    this.connectedTo = destination;
    return destination;
  }
  start(when = 0): void {
    this.startAt = when;
  }
  /* Real sources fire onended on stop() too; mimic the worst case
   * (synchronously) so the generation guard is exercised. */
  stop(): void {
    this.stopped = true;
    this.fireEnded();
  }
  get duration(): number {
    return (this.buffer as FakeBuffer).duration;
  }
  get endAt(): number {
    return (this.startAt ?? 0) + this.duration;
  }
  fireEnded(): void {
    if (this.ended) return;
    this.ended = true;
    this.onended?.(new Event("ended"));
  }
}

class FakeContext implements AudioContextLike {
  currentTime = 0;
  readonly sampleRate = 48_000;
  readonly sources: FakeSource[] = [];
  createBuffer(_channels: number, length: number, sampleRate: number): AudioBufferLike {
    return new FakeBuffer(length, sampleRate);
  }
  createBufferSource(): SourceLike {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  /* Move the clock and fire onended for every started source whose end
   * has passed, in end order, the way the audio thread would. */
  advanceTo(t: number): void {
    this.currentTime = t;
    const due = this.sources
      .filter((s) => !s.ended && !s.stopped && s.startAt !== null && s.endAt <= t)
      .sort((a, b) => a.endAt - b.endAt);
    for (const s of due) s.fireEnded();
  }
}

/* Piper's rate; deliberately not the context's 48k so the "buffer at
 * the segment's own rate" pin is real. */
const SR = 22_050;
const pcmMs = (ms: number): Uint8Array => new Uint8Array(Math.round((ms / 1_000) * SR) * 2);

function harness() {
  const ctx = new FakeContext();
  const destination: AudioNodeLike = { connect: () => undefined };
  const gain = { gain: { value: 1 } };
  const deps: StreamSinkDeps = { ctx, destination, gain };
  const events: string[] = [];
  const sink = createStreamSink(deps, {
    onPlaybackStart: () => events.push("start"),
    onDrained: () => events.push("drained"),
  });
  return { ctx, destination, gain, events, sink };
}

describe("stream-sink: first audio and chaining", () => {
  it("schedules the first chunk at now + 60ms the moment it arrives, before the segment closes", () => {
    const { ctx, destination, events, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(100));
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].startAt).toBeCloseTo(1 + DEFAULT_LEAD_MS / 1_000, 6);
    expect(ctx.sources[0].startAt).toBeCloseTo(1.06, 6);
    expect(ctx.sources[0].connectedTo).toBe(destination);
    expect(events).toEqual(["start"]);
    expect(sink.isActive()).toBe(true);
    expect(sink.leadMs()).toBe(60);
    /* The next chunk chains gaplessly on the playhead, not on a new lead. */
    sink.appendPcm(pcmMs(100));
    expect(ctx.sources[1].startAt).toBeCloseTo(1.16, 6);
    expect(events).toEqual(["start"]);
  });

  it("decodes int16 little-endian to float32 in a buffer at the segment's own rate", () => {
    const { ctx, sink } = harness();
    const i16 = new Int16Array([32_767, -32_768, 0, 16_384]);
    const bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
    sink.beginSegment(SR);
    sink.appendPcm(bytes);
    const buf = ctx.sources[0].buffer as FakeBuffer;
    expect(buf.sampleRate).toBe(SR);
    expect(buf.length).toBe(4);
    expect(buf.data[0]).toBeCloseTo(1, 3);
    expect(buf.data[1]).toBeCloseTo(-1, 6);
    expect(buf.data[2]).toBe(0);
    expect(buf.data[3]).toBeCloseTo(0.5, 6);
  });

  it("ignores an empty chunk and a chunk outside an open segment", () => {
    const { ctx, sink, events } = harness();
    sink.appendPcm(pcmMs(100));
    expect(ctx.sources).toHaveLength(0);
    sink.beginSegment(SR);
    sink.appendPcm(new Uint8Array(0));
    expect(ctx.sources).toHaveLength(0);
    expect(events).toEqual([]);
    expect(sink.isActive()).toBe(false);
  });

  it("a three-segment reply starts once and drains once, after the last padding", () => {
    const { ctx, events, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(300)); /* 1.06 .. 1.36 */
    sink.endSegment(); /* pad 1.36 .. 1.48 */
    ctx.advanceTo(1.2);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(300)); /* 1.48 .. 1.78 */
    sink.endSegment(); /* pad 1.78 .. 1.90 */
    ctx.advanceTo(1.7);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(300)); /* 1.90 .. 2.20 */
    sink.endSegment(); /* pad 2.20 .. 2.32 */
    expect(ctx.sources).toHaveLength(6);
    expect(ctx.sources[2].startAt).toBeCloseTo(1.48, 6);
    expect(ctx.sources[4].startAt).toBeCloseTo(1.9, 6);
    expect(events).toEqual(["start"]);
    expect(sink.isActive()).toBe(true);
    ctx.advanceTo(2.31);
    expect(events).toEqual(["start"]);
    ctx.advanceTo(2.32);
    expect(events).toEqual(["start", "drained"]);
    expect(sink.isActive()).toBe(false);
    expect(ctx.sources.every((s) => !s.stopped)).toBe(true);
  });

  it("does not drain while a segment is still open, even if its audio ran dry", () => {
    const { ctx, events, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(100)); /* 1.06 .. 1.16 */
    ctx.advanceTo(1.5);
    expect(events).toEqual(["start"]);
    expect(sink.isActive()).toBe(true);
  });
});

describe("stream-sink: lead adapts to underruns", () => {
  it("a chunk that arrives after the playhead passed grows the lead by 40ms and schedules with it", () => {
    const { ctx, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(100)); /* 1.06 .. 1.16 */
    ctx.advanceTo(1.5); /* audio ran dry at 1.16 */
    sink.appendPcm(pcmMs(100));
    expect(sink.leadMs()).toBe(DEFAULT_LEAD_MS + LEAD_STEP_MS);
    expect(sink.leadMs()).toBe(100);
    expect(ctx.sources[1].startAt).toBeCloseTo(1.6, 6);
    /* The chunk right behind it chains on the new playhead. */
    sink.appendPcm(pcmMs(100));
    expect(ctx.sources[2].startAt).toBeCloseTo(1.7, 6);
  });

  it("the lead caps at 400ms", () => {
    const { ctx, sink } = harness();
    let t = 1;
    sink.beginSegment(SR);
    for (let i = 0; i < 12; i++) {
      ctx.advanceTo(t);
      sink.appendPcm(pcmMs(50));
      t += 2;
    }
    expect(sink.leadMs()).toBe(MAX_LEAD_MS);
    expect(sink.leadMs()).toBe(400);
  });

  it("a clean segment decays the lead by 10ms, never below 60", () => {
    const { ctx, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(100));
    ctx.advanceTo(1.5);
    sink.appendPcm(pcmMs(100)); /* underrun: 100 */
    sink.endSegment(); /* the segment that underran does not decay */
    expect(sink.leadMs()).toBe(100);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(100));
    sink.endSegment(); /* clean: 90 */
    expect(sink.leadMs()).toBe(90);
    for (let i = 0; i < 6; i++) {
      sink.beginSegment(SR);
      sink.appendPcm(pcmMs(100));
      sink.endSegment();
    }
    expect(sink.leadMs()).toBe(60);
  });
});

describe("stream-sink: padding between segments", () => {
  it("endSegment schedules 120ms of silence and the next segment starts right behind it", () => {
    const { ctx, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(100)); /* 1.06 .. 1.16 */
    sink.endSegment();
    expect(ctx.sources).toHaveLength(2);
    const pad = ctx.sources[1];
    expect(pad.startAt).toBeCloseTo(1.16, 6);
    expect(pad.duration).toBeCloseTo(GAP_MS / 1_000, 6);
    expect(pad.duration).toBeCloseTo(0.12, 6);
    const padBuf = pad.buffer as FakeBuffer;
    expect(padBuf.sampleRate).toBe(SR);
    expect(padBuf.data.every((v) => v === 0)).toBe(true);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(100));
    expect(ctx.sources[2].startAt).toBeCloseTo(1.28, 6);
  });

  it("drains after the end frame even when the audio ran dry before it", () => {
    const { ctx, events, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(100)); /* 1.06 .. 1.16 */
    ctx.advanceTo(1.5);
    sink.endSegment(); /* pad at now, 1.5 .. 1.62 */
    expect(ctx.sources[1].startAt).toBeCloseTo(1.5, 6);
    expect(events).toEqual(["start"]);
    ctx.advanceTo(1.62);
    expect(events).toEqual(["start", "drained"]);
  });

  it("an empty segment adds no padding and does not hold the drain", () => {
    const { ctx, events, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(100));
    sink.endSegment(); /* pad 1.16 .. 1.28 */
    sink.beginSegment(SR);
    ctx.advanceTo(1.4); /* everything ended while the empty segment is open */
    expect(events).toEqual(["start"]);
    sink.endSegment();
    expect(ctx.sources).toHaveLength(2);
    expect(events).toEqual(["start", "drained"]);
  });
});

describe("stream-sink: cancel", () => {
  it("cancelAll mid-run stops every source and returns the ms consumed, padding excluded", () => {
    const { ctx, events, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(500)); /* 1.06 .. 1.56 */
    sink.endSegment(); /* pad 1.56 .. 1.68 */
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(500)); /* 1.68 .. 2.18 */
    ctx.advanceTo(1.3);
    expect(sink.playedMsSoFar()).toBeCloseTo(240, 6);
    ctx.advanceTo(1.8); /* first chunk and pad ended; second chunk 120ms in */
    const { playedMs } = sink.cancelAll();
    expect(playedMs).toBeCloseTo(620, 6);
    expect(ctx.sources.every((s) => s.stopped || s.ended)).toBe(true);
    expect(ctx.sources[2].stopped).toBe(true);
    expect(sink.isActive()).toBe(false);
    expect(sink.playedMsSoFar()).toBe(0);
    expect(events).toEqual(["start"]);
  });

  it("cancel before any audio played reports zero", () => {
    const { ctx, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(500)); /* starts at 1.06 */
    ctx.advanceTo(1.02);
    expect(sink.cancelAll().playedMs).toBe(0);
  });

  it("chunks and the end frame after a cancel are dropped; a fresh segment starts a new run", () => {
    const { ctx, events, sink } = harness();
    ctx.advanceTo(1);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(500));
    sink.cancelAll();
    sink.appendPcm(pcmMs(500));
    sink.endSegment();
    expect(ctx.sources).toHaveLength(1);
    ctx.advanceTo(5);
    expect(events).toEqual(["start"]);
    sink.beginSegment(SR);
    sink.appendPcm(pcmMs(100));
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1].startAt).toBeCloseTo(5.06, 6);
    expect(events).toEqual(["start", "start"]);
    sink.endSegment();
    ctx.advanceTo(5.28);
    expect(events).toEqual(["start", "start", "drained"]);
  });
});

describe("stream-sink: gain", () => {
  it("setGain clamps to 0.2 .. 1.0 and ignores non-finite values", () => {
    const { gain, sink } = harness();
    sink.setGain(0.5);
    expect(gain.gain.value).toBe(0.5);
    sink.setGain(0);
    expect(gain.gain.value).toBe(0.2);
    sink.setGain(-3);
    expect(gain.gain.value).toBe(0.2);
    sink.setGain(5);
    expect(gain.gain.value).toBe(1);
    sink.setGain(Number.NaN);
    expect(gain.gain.value).toBe(1);
    sink.setGain(0.75);
    expect(gain.gain.value).toBe(0.75);
  });
});
