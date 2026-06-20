/**
 * Deny-by-default whitelist (pillar 3.3, sliver V3).
 *
 * Pins: glue is handled alone; ANY project/code/state fact queues to Lex
 * (SMOKE 3.3); a glue phrase embedded in a larger utterance still queues;
 * a stale digest forces queue even for glue (V7 fail-safe).
 */
import { describe, expect, it } from 'vitest';
import { classifyTurn } from '../src/voice/voice-whitelist.js';

describe('deny-by-default whitelist', () => {
  it('handles pure conversational glue alone', () => {
    for (const t of [
      'ok',
      'thanks',
      'got it',
      'yes',
      'no',
      'say that again',
      'repeat that',
      'slower',
      'louder',
    ]) {
      expect(classifyTurn(t).class).toBe('handle');
    }
  });

  it('queues ANY project/code/state question (the probe for 3.3)', () => {
    for (const t of [
      'what did we decide about the schema',
      'how many tests pass',
      'show me the latest commit',
      'what is the stale ref count',
      'is the daemon running',
      'what are we working on',
      'did the build pass',
    ]) {
      const d = classifyTurn(t);
      expect(d.class).toBe('queue');
    }
  });

  it('a glue word inside a larger utterance still queues (full-match only)', () => {
    expect(classifyTurn('yeah and what about the schema').class).toBe('queue');
    expect(classifyTurn('ok so how many bugs are left').class).toBe('queue');
  });

  it('empty input queues', () => {
    expect(classifyTurn('   ').class).toBe('queue');
  });

  it('V7 fail-safe: a stale digest forces queue even for glue', () => {
    expect(classifyTurn('ok', { digestFresh: true }).class).toBe('handle');
    const stale = classifyTurn('ok', { digestFresh: false });
    expect(stale.class).toBe('queue');
    expect(stale.reason).toMatch(/digest-stale/);
  });
});
