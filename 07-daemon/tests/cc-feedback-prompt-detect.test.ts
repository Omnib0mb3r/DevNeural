import { describe, expect, it } from 'vitest';
import {
  __CC_SYSTEM_PROMPT_RE_FOR_TEST as RE,
  __CC_BOX_CHARS_RE_FOR_TEST as BOX_RE,
  __SYSTEM_PROMPT_HOLD_MS_FOR_TEST as HOLD_MS,
  isCcSystemPromptChunk,
} from '../src/dashboard/pty-host.js';

/* Wave 3 fixup (bug: 2026-05-10-cc-feedback-prompt-unanswerable).
 * Pin the regex contract: phrase + box-drawing char must both be
 * present. Phrase-alone matched Lex prose and silenced voice talkback.
 */

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

  it('is case-insensitive on the rating headline', () => {
    expect(RE.test('HOW WOULD YOU RATE')).toBe(true);
  });

  it('does NOT match ordinary assistant text', () => {
    expect(RE.test("Here's the answer you asked for.")).toBe(false);
    expect(RE.test('reading wiki page X')).toBe(false);
    expect(RE.test('1. step one\n2. step two')).toBe(false);
  });

  it('hold window is a meaningful duration', () => {
    expect(HOLD_MS).toBeGreaterThanOrEqual(15_000);
    expect(HOLD_MS).toBeLessThanOrEqual(300_000);
  });
});

describe('CC_BOX_CHARS_RE', () => {
  it('matches box-drawing chars', () => {
    expect(BOX_RE.test('╭─────────────╮')).toBe(true);
    expect(BOX_RE.test('│ content │')).toBe(true);
    expect(BOX_RE.test('╰─╯')).toBe(true);
  });

  it('does NOT match plain prose', () => {
    expect(BOX_RE.test('Lex talking normally about a topic.')).toBe(false);
    expect(BOX_RE.test('1 = thumbs down')).toBe(false);
  });
});

describe('isCcSystemPromptChunk', () => {
  it('trips on a real CC rating overlay chunk', () => {
    const chunk =
      '╭────────────────────────────╮\n' +
      '│ How would you rate this    │\n' +
      '│ session?                   │\n' +
      '│ 1 = thumbs down            │\n' +
      '╰────────────────────────────╯';
    expect(isCcSystemPromptChunk(chunk)).toBe(true);
  });

  it('does NOT trip on Lex reply text containing rating words', () => {
    /* Regression: Lex's own assistant text rendered into the PTY
     * was triggering the gate and silencing voice on turn 2+. */
    const lexProse =
      "Sure, I can help you rate this session if you'd like to " +
      'continue. What did you have in mind?';
    expect(isCcSystemPromptChunk(lexProse)).toBe(false);
  });

  it('does NOT trip on box-drawing alone (no phrase)', () => {
    const chrome = '╭───────╮\n│ hello │\n╰───────╯';
    expect(isCcSystemPromptChunk(chrome)).toBe(false);
  });

  it('does NOT trip on phrase alone (no box)', () => {
    expect(isCcSystemPromptChunk('Continue? (y/n)')).toBe(false);
  });
});
