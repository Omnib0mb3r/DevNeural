import { describe, expect, it } from "vitest";
import {
  createPlaybackQueue,
  type AudioLike,
  type PlaybackQueueDeps,
} from "@/lib/voice-engine/playback-queue";

/**
 * Spec: TTS through a media element; interrupts stop the element
 * instantly and record elapsed ms so context can truncate to the words
 * actually heard; a playback-drained signal marks TRUE audio end (the
 * old daemon tts-end fires at stream end, seconds early).
 *
 * The queue is pure logic over an injected AudioLike so it runs in
 * vitest without a DOM; audio-element-sink.ts binds the real element.
 */

class FakeAudio implements AudioLike {
  src = "";
  currentTime = 0;
  paused = true;
  onended: (() => void) | null = null;
  playCalls = 0;
  pauseCalls = 0;
  play(): Promise<void> {
    this.paused = false;
    this.playCalls++;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
    this.pauseCalls++;
  }
  /* Test helper: simulate the element finishing its current source. */
  finish(durationS: number): void {
    this.currentTime = durationS;
    this.paused = true;
    this.onended?.();
  }
}

function harness() {
  const audio = new FakeAudio();
  const urls: string[] = [];
  const revoked: string[] = [];
  const deps: PlaybackQueueDeps = {
    createAudio: () => audio,
    createObjectUrl: (bytes) => {
      const u = `blob:${urls.length}:${bytes.byteLength}`;
      urls.push(u);
      return u;
    },
    revokeObjectUrl: (u) => revoked.push(u),
  };
  const events: string[] = [];
  const q = createPlaybackQueue(deps, {
    onPlaybackStart: () => events.push("start"),
    onDrained: () => events.push("drained"),
  });
  return { audio, urls, revoked, events, q };
}

/* One second of 16-bit mono audio at 22050 Hz. */
const SR = 22_050;
const oneSecondPcm = () => new Uint8Array(SR * 2);

describe("playback-queue: segment assembly and ordered playback", () => {
  it("a completed segment starts playing immediately when idle", () => {
    const { audio, q, events } = harness();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    expect(audio.playCalls).toBe(1);
    expect(audio.src).toContain("blob:");
    expect(events).toContain("start");
    expect(q.isActive()).toBe(true);
  });

  it("a second segment queues and plays after the first ends", () => {
    const { audio, q } = harness();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    expect(audio.playCalls).toBe(1);
    audio.finish(1.0);
    expect(audio.playCalls).toBe(2);
  });

  it("drained fires only when the last queued segment finishes", () => {
    const { audio, q, events } = harness();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    audio.finish(1.0);
    expect(events).not.toContain("drained");
    audio.finish(1.0);
    expect(events).toContain("drained");
    expect(q.isActive()).toBe(false);
  });

  it("cancelAll stops the element instantly and reports played ms", () => {
    const { audio, q } = harness();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    audio.currentTime = 0.4;
    const r = q.cancelAll();
    expect(audio.pauseCalls).toBeGreaterThan(0);
    expect(r.playedMs).toBeCloseTo(400, -1);
    expect(q.isActive()).toBe(false);
  });

  it("played ms accumulates fully-played segments plus the in-flight position", () => {
    const { audio, q } = harness();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    audio.finish(1.0); // first segment fully played
    audio.currentTime = 0.25; // 250ms into the second
    const r = q.cancelAll();
    expect(r.playedMs).toBeCloseTo(1_250, -1);
  });

  it("cancelAll drops queued segments: nothing plays afterward", () => {
    const { audio, q } = harness();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    q.cancelAll();
    const callsAfterCancel = audio.playCalls;
    audio.finish(1.0);
    expect(audio.playCalls).toBe(callsAfterCancel);
  });

  it("chunks arriving after cancel (stale segment) are discarded", () => {
    const { q, audio } = harness();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.cancelAll();
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    expect(audio.playCalls).toBe(0);
    expect(q.isActive()).toBe(false);
  });

  it("object URLs are revoked after a segment finishes", () => {
    const { audio, q, urls, revoked } = harness();
    q.beginSegment(SR);
    q.appendPcm(oneSecondPcm());
    q.endSegment();
    audio.finish(1.0);
    expect(revoked).toContain(urls[0]);
  });
});
