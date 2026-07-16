/**
 * Fix 24 live repro (2026-07-16 smoke test): mid-reply TTS truncation
 * by phantom barge.
 *
 * The AEC rework leaves the mic hot during playback, so VAD can fire
 * utterance-start on Lex's own audio or room noise. utterance-start
 * kills the in-flight TTS segment AND clears the queued sentences;
 * pre-fix nothing ever resumed when the "utterance" resolved as
 * phantom ([BLANK_AUDIO] / noise floor / suppressed echo), so a long
 * spoken body simply never finished. Observed live at 03:28:30Z.
 *
 * These tests pin the pure resume impl (_resumeBargedSpeechImpl) and
 * the brain-path deadline scaling (lexReplyTimeoutMs) plus the
 * partial-then-timeout latch in voiceLexReply.
 */
import { describe, expect, it } from 'vitest';
import {
  _resumeBargedSpeechImpl,
  BARGE_RESUME_WINDOW_MS,
  type BargeStashEntry,
} from '../src/voice/lex-voice-ws.js';
import {
  lexReplyTimeoutMs,
  voiceLexReply,
} from '../src/voice/voice-top-layer.js';

function stash(over: Partial<BargeStashEntry> = {}): BargeStashEntry {
  return {
    interruptedSegment: 'Sentence three was cut here.',
    queuedSegments: ['Sentence four.', 'Sentence five, the ending.'],
    atMs: 1_000,
    ctrlCPending: true,
    ...over,
  };
}

describe('_resumeBargedSpeechImpl (phantom barge resume)', () => {
  it('re-speaks the interrupted segment first, then the queued remainder', () => {
    const spoken: string[] = [];
    const resumed = _resumeBargedSpeechImpl({
      stash: stash(),
      nowMs: 2_000,
      ttsBusy: false,
      partialChain: [],
      speak: (t) => spoken.push(t),
      reason: 'blank-audio-marker',
      log: () => undefined,
    });
    expect(resumed).toBe(true);
    expect(spoken).toEqual([
      'Sentence three was cut here.',
      'Sentence four.',
      'Sentence five, the ending.',
    ]);
  });

  it('pops the partialChain entry the kill pushed for the resumed segment (Lex is not told about an interruption the operator never noticed)', () => {
    const chain = [
      {
        intended_text: 'Sentence three was cut here.',
        started_at_ms: 900,
        cancelled_at_ms: 1_000,
      },
    ];
    _resumeBargedSpeechImpl({
      stash: stash(),
      nowMs: 2_000,
      ttsBusy: false,
      partialChain: chain,
      speak: () => undefined,
      reason: 'too-few-words',
      log: () => undefined,
    });
    expect(chain.length).toBe(0);
  });

  it('leaves an UNRELATED partialChain entry alone', () => {
    const chain = [
      {
        intended_text: 'a different interrupted line',
        started_at_ms: 900,
        cancelled_at_ms: 1_000,
      },
    ];
    _resumeBargedSpeechImpl({
      stash: stash(),
      nowMs: 2_000,
      ttsBusy: false,
      partialChain: chain,
      speak: () => undefined,
      reason: 'empty',
      log: () => undefined,
    });
    expect(chain.length).toBe(1);
  });

  it('does not resume a stale stash (past the freshness window)', () => {
    const spoken: string[] = [];
    const resumed = _resumeBargedSpeechImpl({
      stash: stash({ atMs: 0 }),
      nowMs: BARGE_RESUME_WINDOW_MS + 1,
      ttsBusy: false,
      partialChain: [],
      speak: (t) => spoken.push(t),
      reason: 'empty',
      log: () => undefined,
    });
    expect(resumed).toBe(false);
    expect(spoken).toEqual([]);
  });

  it('does not resume over fresh speech that superseded the stash', () => {
    const spoken: string[] = [];
    const resumed = _resumeBargedSpeechImpl({
      stash: stash(),
      nowMs: 2_000,
      ttsBusy: true,
      partialChain: [],
      speak: (t) => spoken.push(t),
      reason: 'blank-audio-marker',
      log: () => undefined,
    });
    expect(resumed).toBe(false);
    expect(spoken).toEqual([]);
  });

  it('no-ops on an empty stash (kill fired with nothing playing or queued)', () => {
    const resumed = _resumeBargedSpeechImpl({
      stash: stash({ interruptedSegment: null, queuedSegments: [] }),
      nowMs: 2_000,
      ttsBusy: false,
      partialChain: [],
      speak: () => undefined,
      reason: 'empty',
      log: () => undefined,
    });
    expect(resumed).toBe(false);
  });
});

describe('lexReplyTimeoutMs (brain-path delivery deadline scales with body)', () => {
  it('keeps the render floor for short bodies', () => {
    expect(lexReplyTimeoutMs(20)).toBe(3_000);
  });

  it('scales up for a long body so a streaming delivery is not cut at 3s', () => {
    /* The live 1364-char reply: 2000 + 1364*15 ~= 22.5s. */
    const t = lexReplyTimeoutMs(1364);
    expect(t).toBeGreaterThan(20_000);
    expect(t).toBeLessThanOrEqual(30_000);
  });

  it('caps at 30s for pathological bodies', () => {
    expect(lexReplyTimeoutMs(100_000)).toBe(30_000);
  });

  it('an explicit override wins untouched (test contract)', () => {
    expect(lexReplyTimeoutMs(100_000, 1_234)).toBe(1_234);
  });
});

describe('voiceLexReply partial-then-timeout latch', () => {
  it('logs the mid-stream cut loudly when partials flowed but the ask never closed, and still reports delivered', async () => {
    const logs: string[] = [];
    const spoken: string[] = [];
    const delivered = await voiceLexReply('A long body. With several sentences.', {
      onSpeech: (l) => spoken.push(l),
      log: (m) => logs.push(m),
      deps: {
        ask: async (args) => {
          args.onPartial?.('A long body.');
          return null; /* timeout: the tail never streamed */
        },
        timeoutMs: 100,
      },
    });
    expect(delivered).toBe(true);
    expect(spoken).toEqual(['A long body.']);
    expect(logs.some((l) => l.includes('DELIVERY CUT MID-STREAM'))).toBe(true);
  });

  it('does not log a cut when the ask closes normally', async () => {
    const logs: string[] = [];
    const delivered = await voiceLexReply('Short body.', {
      onSpeech: () => undefined,
      log: (m) => logs.push(m),
      deps: {
        ask: async (args) => {
          args.onPartial?.('Short body.');
          return 'Short body.';
        },
        timeoutMs: 100,
      },
    });
    expect(delivered).toBe(true);
    expect(logs.length).toBe(0);
  });
});
