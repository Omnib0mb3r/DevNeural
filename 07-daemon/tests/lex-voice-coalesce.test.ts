/**
 * Coalesce-utterance-queue helpers (Fix 35 Phase A).
 *
 * Pure unit pins for the queue drain formatter and the contradiction
 * detector. The WS state machine that calls these helpers is
 * exercised indirectly via the existing lex-voice-ws regression
 * tests; this file pins the two rules independently so a regression
 * surfaces at the helper boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  detectContradiction,
  formatQueueDrain,
} from '../src/voice/lex-voice-coalesce.js';

describe('formatQueueDrain', () => {
  it('returns null for an empty queue', () => {
    expect(formatQueueDrain([])).toBeNull();
  });

  it('returns the lone utterance unchanged when the queue has one item', () => {
    const r = formatQueueDrain(['fix the build']);
    expect(r).not.toBeNull();
    expect(r!.text).toBe('fix the build');
    expect(r!.count).toBe(1);
  });

  it('wraps a multi-utterance batch in a structured numbered preamble', () => {
    const r = formatQueueDrain([
      'add the snippet picker',
      'also bump the FIXES row',
      'commit when done',
    ]);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(3);
    expect(r!.text).toMatch(/queued-utterances \(3\)/);
    expect(r!.text).toMatch(/Compose ONE reply addressing all of them/);
    expect(r!.text).toMatch(/1\. add the snippet picker/);
    expect(r!.text).toMatch(/2\. also bump the FIXES row/);
    expect(r!.text).toMatch(/3\. commit when done/);
  });

  it('preserves order so latest-utterance contradiction logic stays meaningful', () => {
    const r = formatQueueDrain(['ship it', 'wait no, cancel that']);
    expect(r!.text.indexOf('1. ship it')).toBeLessThan(
      r!.text.indexOf('2. wait no'),
    );
  });
});

describe('detectContradiction', () => {
  it('returns true for canonical cancel phrasings', () => {
    expect(detectContradiction('cancel that')).toBe(true);
    expect(detectContradiction('cancel it')).toBe(true);
    expect(detectContradiction('never mind')).toBe(true);
    expect(detectContradiction('nevermind')).toBe(true);
    expect(detectContradiction('forget it')).toBe(true);
    expect(detectContradiction('forget that')).toBe(true);
    expect(detectContradiction('stop it')).toBe(true);
    expect(detectContradiction('stop now please')).toBe(true);
    expect(detectContradiction('abort that')).toBe(true);
    expect(detectContradiction('drop it')).toBe(true);
    expect(detectContradiction('hold up')).toBe(true);
    expect(detectContradiction('hold on')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectContradiction('NEVER MIND')).toBe(true);
    expect(detectContradiction('Cancel That')).toBe(true);
  });

  it('does NOT false-fire on word-boundary collisions', () => {
    expect(detectContradiction('stopwatch behaviour was correct')).toBe(false);
    expect(detectContradiction('the cancellation policy looks fine')).toBe(
      false,
    );
    expect(detectContradiction('hold the door open')).toBe(false);
    expect(detectContradiction('I cannot stop thinking about it')).toBe(false);
  });

  it('returns false for empty / whitespace input', () => {
    expect(detectContradiction('')).toBe(false);
    expect(detectContradiction('   ')).toBe(false);
  });
});
