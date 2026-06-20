/**
 * Control channel (pillar 3.5, sliver V2).
 *
 * Pins: quiet/ambiguous-stop -> kill-tts (zero round-trip); stop-work +
 * abort -> interrupt; redirect -> interrupt-then-inject with payload;
 * ordinary speech is NOT control (null = falls to the data lane).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyControl,
  isControl,
} from '../src/voice/voice-control-channel.js';

describe('control channel classifier', () => {
  it('quiet phrases kill TTS locally (zero Lex round-trip)', () => {
    for (const t of ['quiet', 'be quiet', 'shush', 'shut up', 'stop talking', "that's enough"]) {
      const d = classifyControl(t);
      expect(d?.intent).toBe('quiet');
      expect(d?.action).toBe('kill-tts');
      expect(d?.queued).toBe(false);
    }
  });

  it('ambiguous bare "stop" defaults to silencing the voice (Hole 6c)', () => {
    const d = classifyControl('stop');
    expect(d?.intent).toBe('quiet');
    expect(d?.action).toBe('kill-tts');
  });

  it('a qualified stop targets the work -> interrupt', () => {
    for (const t of ['stop the work', 'stop working', 'halt', 'stop the worker']) {
      const d = classifyControl(t);
      expect(d?.intent).toBe('stop-work');
      expect(d?.action).toBe('interrupt');
    }
  });

  it('abort -> interrupt', () => {
    expect(classifyControl('abort')?.action).toBe('interrupt');
    expect(classifyControl('cancel that')?.intent).toBe('abort');
  });

  it('redirect carries the instruction and interrupts-then-injects', () => {
    const d = classifyControl('actually, switch to the postgres branch');
    expect(d?.intent).toBe('redirect');
    expect(d?.action).toBe('interrupt-then-inject');
    expect(d?.payload).toBe('switch to the postgres branch');
  });

  it('"scratch that, do X instead" is a redirect', () => {
    const d = classifyControl('scratch that, run the tests first');
    expect(d?.intent).toBe('redirect');
    expect(d?.payload).toBe('run the tests first');
  });

  it('ordinary speech is NOT control (falls to data lane)', () => {
    for (const t of [
      'what did we decide about the schema',
      'tell me the latest commit',
      'how many tests pass',
      'yes',
      'actually',
    ]) {
      expect(classifyControl(t)).toBeNull();
      expect(isControl(t)).toBe(false);
    }
  });

  it('bare "actually" with no instruction is not a redirect', () => {
    expect(classifyControl('actually')).toBeNull();
  });
});
