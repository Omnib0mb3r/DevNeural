/**
 * Layer 1 live block (LAYER-1-CONTROL.md, "The per-utterance turn"): the
 * [live] header every L1 message carries so the voice can see what the
 * brain and the worker are doing, what it last said, the digest, and
 * anything pending (a plan awaiting approval, a parked dispatch).
 */
import { describe, expect, it } from 'vitest';
import {
  buildTopLayerEventMessage,
  buildTopLayerTurnMessage,
  renderLiveBlock,
  type LiveBlock,
} from '../src/voice/voice-top-layer.js';

const BASE: LiveBlock = {
  mid: 'idle',
  midSinceMs: null,
  midTool: null,
  worker: null,
  lastSaid: null,
  digest: null,
  pendingPlan: null,
  pendingDispatch: null,
  nowMs: 0,
};

describe('renderLiveBlock', () => {
  it('renders every mid state with elapsed seconds where it matters', () => {
    expect(renderLiveBlock(BASE)).toBe('[live] brain: idle');
    expect(renderLiveBlock({ ...BASE, mid: 'down' })).toBe('[live] brain: down');
    expect(renderLiveBlock({ ...BASE, mid: 'replying' })).toBe('[live] brain: replying');
    expect(
      renderLiveBlock({ ...BASE, mid: 'warming', midSinceMs: 1_000, nowMs: 13_000 }),
    ).toBe('[live] brain: warming 12s');
    expect(
      renderLiveBlock({ ...BASE, mid: 'thinking', midSinceMs: 5_000, nowMs: 45_000 }),
    ).toBe('[live] brain: thinking 40s');
    expect(
      renderLiveBlock({
        ...BASE,
        mid: 'tool',
        midTool: 'Read',
        midSinceMs: 5_000,
        nowMs: 45_000,
      }),
    ).toBe('[live] brain: tool Read 40s');
  });

  it('adds the optional lines only when present', () => {
    const s = renderLiveBlock({
      ...BASE,
      mid: 'warming',
      midSinceMs: 1_000,
      nowMs: 13_000,
      worker: 'idle',
      lastSaid: 'Right then.',
      digest: {
        currentTask: 'dropship research',
        lastDecision: '',
        openQuestion: '',
        workerStatus: '',
        nextSteps: 'phase 2',
      },
      pendingPlan: '# Plan\n1. do x\n2. do y',
      pendingDispatch: { id: 'd1', summary: 'run the tests' },
    });
    expect(s).toMatch(/^\[live\] brain: warming 12s$/m);
    expect(s).toMatch(/worker: idle/);
    expect(s).toMatch(/last said: "Right then\."/);
    expect(s).toMatch(/Current task: dropship research/);
    expect(s).toMatch(/Last decision: \(none\)/);
    expect(s).toMatch(/plan pending: # Plan 1\. do x 2\. do y/);
    expect(s).toMatch(/dispatch pending \(d1\): run the tests/);
    expect(s).not.toMatch(/—|–/);
  });
});

describe('turn + event messages', () => {
  it('the turn message carries the live block, the utterance and the barge flags', () => {
    const msg = buildTopLayerTurnMessage(
      'what is she doing',
      { ...BASE, mid: 'tool', midTool: 'Read', midSinceMs: 5_000, nowMs: 45_000 },
      { duringTts: true, words: 4 },
    );
    expect(msg).toMatch(/^\[live\] brain: tool Read 40s/);
    expect(msg).toMatch(/\[heard\] "what is she doing"  \(during_tts: yes, words: 4\)$/);
  });

  it('the event message tags the event kind and id', () => {
    const msg = buildTopLayerEventMessage(
      { kind: 'dispatch-pending', id: 'd1', text: 'the brain wants to send the worker: run tests' },
      BASE,
    );
    expect(msg).toBe(
      '[live] brain: idle\n[event] dispatch-pending d1: the brain wants to send the worker: run tests',
    );
    expect(buildTopLayerEventMessage({ kind: 'brain-progress', text: 'still on it' }, BASE)).toBe(
      '[live] brain: idle\n[event] brain-progress: still on it',
    );
  });
});
