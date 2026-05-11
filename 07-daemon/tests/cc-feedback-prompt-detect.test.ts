import { describe, expect, it } from 'vitest';
import {
  __CC_SYSTEM_PROMPT_RE_FOR_TEST as RE,
  __SYSTEM_PROMPT_HOLD_MS_FOR_TEST as HOLD_MS,
} from '../src/dashboard/pty-host.js';

/* Wave 3 fixup (bug: 2026-05-10-cc-feedback-prompt-unanswerable).
 * Pin the regex contract: any of the documented CC prompt phrases must
 * trip the gate; normal Lex / assistant turn text must not. */

describe('CC_SYSTEM_PROMPT_RE', () => {
  it('matches the rating-prompt headline', () => {
    expect(RE.test('How would you rate this session?')).toBe(true);
  });

  it('matches the rating-scale legend', () => {
    expect(RE.test('1 = thumbs down, 5 = thumbs up')).toBe(true);
  });

  it('matches the interaction rating phrasing', () => {
    expect(RE.test('Rate this interaction:')).toBe(true);
  });

  it('matches y/n continue prompts', () => {
    expect(RE.test('Continue? (y/n)')).toBe(true);
  });

  it('matches press-enter-to-continue prompts', () => {
    expect(RE.test('Press Enter to continue')).toBe(true);
  });

  it('is case-insensitive on the rating headline', () => {
    expect(RE.test('HOW WOULD YOU RATE')).toBe(true);
  });

  it('does NOT match ordinary assistant text', () => {
    expect(RE.test("Here's the answer you asked for.")).toBe(false);
    expect(RE.test('reading wiki page X')).toBe(false);
    expect(RE.test('1. step one\n2. step two')).toBe(false);
  });

  it('hold window is a meaningful duration', () => {
    expect(HOLD_MS).toBeGreaterThanOrEqual(30_000);
    expect(HOLD_MS).toBeLessThanOrEqual(300_000);
  });
});
