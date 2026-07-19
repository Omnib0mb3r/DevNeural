/**
 * Front-line barge classifier (VOICE-BARGE-CLASSIFIER-SPEC §3).
 *
 * Pure, deterministic bucketing of an utterance that arrives during
 * TTS. Precedence: emergency-stop > echo > backchannel > noise >
 * escalate. The deterministic buckets are resolved here on the voice
 * layer; only 'escalate' hands off to the top-layer LLM, which then
 * decides AI-interpreted command (§3.1b) vs real turn (§3.5). There is
 * NO resume anywhere — echo/noise/backchannel mean the gate should
 * never have stopped playback; escalate/emergency mean a real stop that
 * STAYS stopped.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyBarge,
  isBackchannelUtterance,
} from '../src/voice/engine/barge-classifier.js';

const base = {
  isEcho: false,
  isBlank: false,
  isBackchannel: false,
  wordCount: 4,
  stopVerdict: null as 'stop_speaking' | 'interrupt_work' | null,
};

describe('classifyBarge precedence', () => {
  it('emergency-stop wins over everything (a stop verdict is a command)', () => {
    expect(
      classifyBarge({ ...base, stopVerdict: 'interrupt_work', isEcho: true }),
    ).toBe('emergency-stop');
    expect(classifyBarge({ ...base, stopVerdict: 'stop_speaking' })).toBe(
      'emergency-stop',
    );
  });

  it('echo beats backchannel/noise/escalate', () => {
    expect(
      classifyBarge({ ...base, isEcho: true, isBackchannel: true }),
    ).toBe('echo');
  });

  it('backchannel beats noise and escalate', () => {
    expect(
      classifyBarge({ ...base, isBackchannel: true, wordCount: 1 }),
    ).toBe('backchannel');
  });

  it('blank audio or sub-2-words is noise', () => {
    expect(classifyBarge({ ...base, isBlank: true })).toBe('noise');
    expect(classifyBarge({ ...base, wordCount: 1 })).toBe('noise');
  });

  it('a real multi-word non-echo non-command utterance escalates to the top layer', () => {
    // "Testing, testing, barge in, barge in" — the live repro. Escalates
    // so the LLM decides command vs real turn; either way it STAYS
    // stopped, never resumes.
    expect(classifyBarge({ ...base, wordCount: 5 })).toBe('escalate');
  });
});

describe('isBackchannelUtterance', () => {
  it('single-word agreements are backchannel', () => {
    for (const w of ['yeah', 'yep', 'ok', 'okay', 'right', 'mhm', 'sure']) {
      expect(isBackchannelUtterance(w)).toBe(true);
    }
  });

  it('multi-word backchannel phrases are backchannel', () => {
    for (const p of ['uh huh', 'got it', 'makes sense', 'i see']) {
      expect(isBackchannelUtterance(p)).toBe(true);
    }
  });

  it('repeated / stacked agreements are still backchannel', () => {
    expect(isBackchannelUtterance('yeah yeah')).toBe(true);
    expect(isBackchannelUtterance('yeah, ok')).toBe(true);
  });

  it('punctuation and case are ignored', () => {
    expect(isBackchannelUtterance('Yeah!')).toBe(true);
    expect(isBackchannelUtterance('  Okay.  ')).toBe(true);
  });

  it('a real instruction is NOT backchannel', () => {
    expect(isBackchannelUtterance('stop what you are doing')).toBe(false);
    expect(isBackchannelUtterance('no do it the other way')).toBe(false);
    expect(isBackchannelUtterance('')).toBe(false);
  });
});
