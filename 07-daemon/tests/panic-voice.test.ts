/**
 * Lex voice-command panic matcher (PANIC-BUTTON.md step 6).
 *
 * The spec lists three trigger phrases: "emergency stop", "kill the
 * worker", "panic". Match is word-bounded and case-insensitive; longer
 * sentences that happen to contain the trigger ("can you panic on my
 * behalf?") count too, since the user has clearly asked for the
 * action. Non-trigger phrases must not false-fire.
 */
import { describe, expect, it } from 'vitest';
import { matchesPanicCommand } from '../src/voice/panic-voice.js';

describe('matchesPanicCommand', () => {
  it('matches exact panic', () => {
    expect(matchesPanicCommand('panic')).toBe(true);
  });

  it('matches Panic with stray punctuation and casing', () => {
    expect(matchesPanicCommand('Panic!')).toBe(true);
  });

  it('matches "emergency stop"', () => {
    expect(matchesPanicCommand('emergency stop')).toBe(true);
  });

  it('matches "kill the worker"', () => {
    expect(matchesPanicCommand('kill the worker')).toBe(true);
  });

  it('matches embedded triggers inside a longer utterance', () => {
    expect(matchesPanicCommand('Lex, please panic now')).toBe(true);
    expect(
      matchesPanicCommand('we need an emergency stop right away'),
    ).toBe(true);
  });

  it('does not false-fire on similar words', () => {
    expect(matchesPanicCommand('the panicked user retried')).toBe(false);
    expect(matchesPanicCommand('emergency contact info')).toBe(false);
    expect(matchesPanicCommand('please kill the worker process later')).toBe(
      true,
    );
    expect(matchesPanicCommand('how do I work less')).toBe(false);
  });

  it('returns false on empty text', () => {
    expect(matchesPanicCommand('')).toBe(false);
    expect(matchesPanicCommand('   ')).toBe(false);
  });
});
