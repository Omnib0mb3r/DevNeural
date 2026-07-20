import { describe, expect, it } from 'vitest';
import {
  createBargeGateState,
  advanceBargeGate,
  type BargeGateState,
} from '../src/voice/engine/barge-word-gate.js';

/**
 * Sound-gated barge (LAYER-1-CONTROL.md baseline, 2026-07-20): during TTS
 * playback a VAD onset FIRES immediately - any noise over the floor stops
 * the audio, no wait for the transcriber. A barge never resumes and the
 * L2/L1 statement stays readable as text, so a false stop on noise costs
 * only the audio. (The earlier word-gate - VAD arms, 2 interim words fire -
 * is gone.)
 */
const notEcho = () => false;

function run(
  state: BargeGateState,
  events: Parameters<typeof advanceBargeGate>[1][],
  isEchoText: (t: string) => boolean = notEcho,
): { state: BargeGateState; fires: number } {
  let fires = 0;
  for (const ev of events) {
    const r = advanceBargeGate(state, ev, { isEchoText });
    state = r.state;
    if (r.fire) fires++;
  }
  return { state, fires };
}

describe('barge sound-gate: any noise during playback stops the audio', () => {
  it('VAD onset during playback FIRES immediately (no word wait)', () => {
    const r = advanceBargeGate(
      createBargeGateState(),
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { isEchoText: notEcho },
    );
    expect(r.fire).toBe(true);
    expect(r.state.phase).toBe('fired');
  });

  it('VAD onset with no playback stays idle (nothing to interrupt)', () => {
    const r = advanceBargeGate(
      createBargeGateState(),
      { type: 'vad-onset', atMs: 1_000, playbackActive: false },
      { isEchoText: notEcho },
    );
    expect(r.state.phase).toBe('idle');
    expect(r.fire).toBe(false);
  });

  it('fires at most once - a second onset while already fired does not re-fire', () => {
    const { fires, state } = run(createBargeGateState(), [
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { type: 'vad-onset', atMs: 1_200, playbackActive: true },
    ]);
    expect(fires).toBe(1);
    expect(state.phase).toBe('fired');
  });

  it('words arriving after the sound-fire do not re-fire (audio already cut)', () => {
    const { fires } = run(createBargeGateState(), [
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { type: 'words', kind: 'interim', text: 'hold on', atMs: 1_300 },
      { type: 'words', kind: 'final', text: 'hold on lex', atMs: 1_600 },
    ]);
    expect(fires).toBe(1);
  });

  it('a playback-idle resolution disarms so the next onset can fire again', () => {
    const { state, fires } = run(createBargeGateState(), [
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { type: 'playback-idle', atMs: 2_000 },
      { type: 'vad-onset', atMs: 3_000, playbackActive: true },
    ]);
    expect(fires).toBe(2);
    expect(state.phase).toBe('fired');
  });

  it('phantom resolution disarms without an extra fire', () => {
    const { state, fires } = run(createBargeGateState(), [
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { type: 'phantom', atMs: 2_000 },
    ]);
    /* the onset fired once; phantom just resets state for the next run */
    expect(fires).toBe(1);
    expect(state.phase).toBe('idle');
  });

  it('bare words with no playing audio never fire (no onset context)', () => {
    const { fires } = run(createBargeGateState(), [
      { type: 'words', kind: 'final', text: 'hello there', atMs: 1_000 },
    ]);
    expect(fires).toBe(0);
  });
});
