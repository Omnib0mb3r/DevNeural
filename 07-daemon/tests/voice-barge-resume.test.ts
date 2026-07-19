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

/* Fix 24 tail-loss (2026-07-18 spec, Fix 1): once Fix 51 synth-
 * serialization ships every sentence to the client ahead of realtime
 * playback, the mid/deep body has drained off the server ttsQueue by
 * barge time, so the per-segment stash captures only the in-flight
 * sentence. The remainder-resume reconstructs the UN-heard tail of the
 * WHOLE original body from the full spoken run + the client's played
 * offset, so sentences 2..N are never lost. */
describe('_resumeBargedSpeechImpl (full-body remainder resume)', () => {
  const FULL = 'One two three. Four five six. Seven eight nine.';

  it('re-speaks the un-played remainder of the whole body from played_ms, not the drained segment snapshot', () => {
    const spoken: string[] = [];
    /* Segment snapshot lost the tail: only sentence 1 survived on the
     * server queue. playedMs covers just sentence 1 (14 chars at
     * 10ms/char = 140ms). */
    const resumed = _resumeBargedSpeechImpl({
      stash: stash({
        interruptedSegment: 'One two three.',
        queuedSegments: [],
        fullRunText: FULL,
        playedMs: 140,
      }),
      nowMs: 2_000,
      ttsBusy: false,
      partialChain: [],
      speak: (t) => spoken.push(t),
      reason: 'echo-filter',
      log: () => undefined,
      msPerChar: 10,
    });
    expect(resumed).toBe(true);
    /* One unsplit resume segment carrying the whole unheard tail -
     * mirrors the top layer, which resumes its single segment whole. */
    expect(spoken).toEqual(['Four five six. Seven eight nine.']);
  });

  it('appends still-queued segments that never shipped to the run text', () => {
    const spoken: string[] = [];
    /* fullRunText only covers what got a tts-start (sentences 1-2);
     * sentence 3 was still on the queue at barge time, absent from the
     * run text - it must still resume. */
    const resumed = _resumeBargedSpeechImpl({
      stash: stash({
        interruptedSegment: 'Four five six.',
        queuedSegments: ['Seven eight nine.'],
        fullRunText: 'One two three. Four five six.',
        playedMs: 140,
      }),
      nowMs: 2_000,
      ttsBusy: false,
      partialChain: [],
      speak: (t) => spoken.push(t),
      reason: 'echo-filter',
      log: () => undefined,
      msPerChar: 10,
    });
    expect(resumed).toBe(true);
    expect(spoken).toEqual(['Four five six. Seven eight nine.']);
  });

  it('falls back to the per-segment snapshot when the client reported no offset (legacy client / playedMs null)', () => {
    const spoken: string[] = [];
    const resumed = _resumeBargedSpeechImpl({
      stash: stash({
        interruptedSegment: 'Sentence three was cut here.',
        queuedSegments: ['Sentence four.'],
        fullRunText: FULL,
        playedMs: null,
      }),
      nowMs: 2_000,
      ttsBusy: false,
      partialChain: [],
      speak: (t) => spoken.push(t),
      reason: 'empty',
      log: () => undefined,
    });
    expect(resumed).toBe(true);
    expect(spoken).toEqual(['Sentence three was cut here.', 'Sentence four.']);
  });

  it('does not resume when the whole body was already heard and nothing is queued', () => {
    const spoken: string[] = [];
    const resumed = _resumeBargedSpeechImpl({
      stash: stash({
        interruptedSegment: 'Seven eight nine.',
        queuedSegments: [],
        fullRunText: FULL,
        playedMs: 100_000,
      }),
      nowMs: 2_000,
      ttsBusy: false,
      partialChain: [],
      speak: (t) => spoken.push(t),
      reason: 'echo-filter',
      log: () => undefined,
      msPerChar: 10,
    });
    expect(resumed).toBe(false);
    expect(spoken).toEqual([]);
  });

  it('pops the partialChain entry the kill pushed, in the remainder path too', () => {
    const chain = [
      {
        intended_text: 'One two three.',
        started_at_ms: 900,
        cancelled_at_ms: 1_000,
      },
    ];
    _resumeBargedSpeechImpl({
      stash: stash({
        interruptedSegment: 'One two three.',
        queuedSegments: [],
        fullRunText: FULL,
        playedMs: 140,
      }),
      nowMs: 2_000,
      ttsBusy: false,
      partialChain: chain,
      speak: () => undefined,
      reason: 'echo-filter',
      log: () => undefined,
      msPerChar: 10,
    });
    expect(chain.length).toBe(0);
  });
});

describe('lexReplyTimeoutMs (brain-path delivery deadline scales with body)', () => {
  it('keeps the render floor for short bodies (8s time-to-first-record, 2026-07-16)', () => {
    expect(lexReplyTimeoutMs(20)).toBe(8_000);
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
  it("logs the mid-stream cut loudly when partials flowed but the ask never closed, and reports 'cut' so the caller re-delivers", async () => {
    const logs: string[] = [];
    const spoken: string[] = [];
    const outcome = await voiceLexReply('A long body. With several sentences.', {
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
    expect(outcome).toBe('cut');
    expect(spoken).toEqual(['A long body.']);
    expect(logs.some((l) => l.includes('DELIVERY CUT MID-STREAM'))).toBe(true);
  });

  it('does not log a cut when the ask closes normally', async () => {
    const logs: string[] = [];
    const outcome = await voiceLexReply('Short body.', {
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
    expect(outcome).toBe('delivered');
    expect(logs.length).toBe(0);
  });
});
