/**
 * Lex voice-command panic matcher (PANIC-BUTTON.md step 6).
 *
 * Trigger phrase tightened 2026-05-13 to "emergency stop" only.
 * Bare "panic" and "kill the worker" were dropped after six
 * pty_not_found rows landed in panic_log from voice misfires when
 * the operator said "panic" mid-conversation. Match remains
 * word-bounded and case-insensitive; longer sentences that
 * embed the two-word phrase still count.
 */
import { describe, expect, it } from 'vitest';
import { matchesPanicCommand } from '../src/voice/panic-voice.js';

describe('matchesPanicCommand', () => {
  it('matches "emergency stop"', () => {
    expect(matchesPanicCommand('emergency stop')).toBe(true);
  });

  it('matches "Emergency Stop" with stray punctuation and casing', () => {
    expect(matchesPanicCommand('Emergency Stop!')).toBe(true);
  });

  it('matches embedded "emergency stop" inside a longer utterance', () => {
    expect(
      matchesPanicCommand('we need an emergency stop right away'),
    ).toBe(true);
  });

  it('does NOT match bare "panic" (dropped 2026-05-13)', () => {
    expect(matchesPanicCommand('panic')).toBe(false);
    expect(matchesPanicCommand('Panic!')).toBe(false);
    expect(matchesPanicCommand('Lex, please panic now')).toBe(false);
  });

  it('does NOT match "kill the worker" (dropped 2026-05-13)', () => {
    expect(matchesPanicCommand('kill the worker')).toBe(false);
    expect(
      matchesPanicCommand('please kill the worker process later'),
    ).toBe(false);
  });

  it('does not false-fire on similar words', () => {
    expect(matchesPanicCommand('the panicked user retried')).toBe(false);
    expect(matchesPanicCommand('emergency contact info')).toBe(false);
    expect(matchesPanicCommand('how do I work less')).toBe(false);
  });

  it('returns false on empty text', () => {
    expect(matchesPanicCommand('')).toBe(false);
    expect(matchesPanicCommand('   ')).toBe(false);
  });
});
