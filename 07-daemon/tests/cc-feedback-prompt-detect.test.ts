import { describe, expect, it } from 'vitest';
import {
  __CC_SYSTEM_PROMPT_RE_FOR_TEST as RE,
  __CC_BOX_CHARS_RE_FOR_TEST as BOX_RE,
  __SYSTEM_PROMPT_HOLD_MS_FOR_TEST as HOLD_MS,
  isCcSystemPromptChunk,
  shouldAutoDismissSystemPrompt,
  CC_SYSTEM_PROMPT_DISMISS_COOLDOWN_MS,
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

  it('trips on the newer "How is Claude doing this session?" overlay', () => {
    const chunk =
      '╭──────────────────────────────────╮\n' +
      '│ How is Claude doing this session? │\n' +
      '│ 1: Bad                            │\n' +
      '│ 2: Fine                           │\n' +
      '│ 3: Good                           │\n' +
      '│ 0: Dismiss                        │\n' +
      '╰──────────────────────────────────╯';
    expect(isCcSystemPromptChunk(chunk)).toBe(true);
  });

  it('still requires box-drawing even for the new variant', () => {
    /* Without the box-drawing requirement, the new phrase would
     * trigger on assistant prose like "I want to know how Claude
     * is doing this session" or any documentation that quotes the
     * dismiss menu. */
    expect(
      isCcSystemPromptChunk('How is Claude doing this session? Let me know.'),
    ).toBe(false);
  });
});

describe('shouldAutoDismissSystemPrompt', () => {
  const COOLDOWN = CC_SYSTEM_PROMPT_DISMISS_COOLDOWN_MS;
  const newOverlay =
    '╭──────────────────────────────────╮\n' +
    '│ How is Claude doing this session? │\n' +
    '│ 0: Dismiss                        │\n' +
    '╰──────────────────────────────────╯';

  it('returns true on a fresh CC overlay chunk with no prior dismissal', () => {
    expect(shouldAutoDismissSystemPrompt(newOverlay, 0, 1_000_000)).toBe(true);
  });

  it('returns false on a redraw chunk inside the cooldown window', () => {
    /* CC redraws the overlay several times within a single prompt
     * (border re-render, cursor blink); without the cooldown we
     * would auto-write multiple '0\r' on the same prompt. */
    const lastDismiss = 1_000_000;
    expect(
      shouldAutoDismissSystemPrompt(
        newOverlay,
        lastDismiss,
        lastDismiss + COOLDOWN - 1,
      ),
    ).toBe(false);
  });

  it('returns true once the cooldown has elapsed', () => {
    const lastDismiss = 1_000_000;
    expect(
      shouldAutoDismissSystemPrompt(
        newOverlay,
        lastDismiss,
        lastDismiss + COOLDOWN + 1,
      ),
    ).toBe(true);
  });

  it('returns false for ordinary Lex prose even after cooldown elapsed', () => {
    /* The cooldown gate only matters when the regex already matched.
     * Non-matching prose must never trigger auto-dismiss regardless
     * of how long ago the last real dismiss was. */
    expect(
      shouldAutoDismissSystemPrompt(
        "Sure, I'll handle that.",
        0,
        9_999_999_999,
      ),
    ).toBe(false);
  });

  it('returns false for box-drawing alone (no phrase)', () => {
    expect(
      shouldAutoDismissSystemPrompt('╭───╮\n│ x │\n╰───╯', 0, 9_999_999_999),
    ).toBe(false);
  });
});
