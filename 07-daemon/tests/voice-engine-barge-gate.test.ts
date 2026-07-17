import { describe, expect, it } from 'vitest';
import {
  createBargeGateState,
  advanceBargeGate,
  type BargeGateState,
} from '../src/voice/engine/barge-word-gate.js';

/**
 * Spec: during TTS playback, silero VAD onset only ARMS a candidate.
 * Playback dies only when streaming ASR yields at least 2 interim words
 * (or 1 final word) that do not match the TTS text. Raw-VAD interruption
 * is the documented anti-pattern (noise kills playback) and is what the
 * pipeline accidentally has today.
 */
const notEcho = () => false;
const isEcho = () => true;

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

describe('barge-word-gate: words interrupt, noise never does', () => {
  it('VAD onset during playback arms but does not fire', () => {
    const r = advanceBargeGate(
      createBargeGateState(),
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { isEchoText: notEcho },
    );
    expect(r.state.phase).toBe('armed');
    expect(r.fire).toBe(false);
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

  it('fires on two interim words that are not echo', () => {
    const { fires } = run(createBargeGateState(), [
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { type: 'words', kind: 'interim', text: 'hold on', atMs: 1_300 },
    ]);
    expect(fires).toBe(1);
  });

  it('one interim word is not enough', () => {
    const { state, fires } = run(createBargeGateState(), [
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { type: 'words', kind: 'interim', text: 'uh', atMs: 1_300 },
    ]);
    expect(fires).toBe(0);
    expect(state.phase).toBe('armed');
  });

  it('one FINAL word is enough', () => {
    const { fires } = run(createBargeGateState(), [
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { type: 'words', kind: 'final', text: 'stop', atMs: 1_600 },
    ]);
    expect(fires).toBe(1);
  });

  it('echo words never fire the gate', () => {
    const { state, fires } = run(
      createBargeGateState(),
      [
        { type: 'vad-onset', atMs: 1_000, playbackActive: true },
        { type: 'words', kind: 'final', text: 'tests are green', atMs: 1_500 },
      ],
      isEcho,
    );
    expect(fires).toBe(0);
    expect(state.phase).toBe('armed');
  });

  it('phantom resolution disarms without firing', () => {
    const { state, fires } = run(createBargeGateState(), [
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { type: 'phantom', atMs: 2_000 },
    ]);
    expect(fires).toBe(0);
    expect(state.phase).toBe('idle');
  });

  it('fires at most once per armed cycle', () => {
    const { fires } = run(createBargeGateState(), [
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { type: 'words', kind: 'interim', text: 'hold on a second', atMs: 1_300 },
      { type: 'words', kind: 'final', text: 'hold on a second lex', atMs: 1_900 },
    ]);
    expect(fires).toBe(1);
  });

  it('words with no prior arm do not fire (no playback context)', () => {
    const { fires } = run(createBargeGateState(), [
      { type: 'words', kind: 'final', text: 'hello there', atMs: 1_000 },
    ]);
    expect(fires).toBe(0);
  });

  it('a stale armed candidate expires: onset long ago, words much later', () => {
    const { fires } = run(createBargeGateState(), [
      { type: 'vad-onset', atMs: 1_000, playbackActive: true },
      { type: 'words', kind: 'interim', text: 'hold on', atMs: 20_000 },
    ]);
    expect(fires).toBe(0);
  });
});
