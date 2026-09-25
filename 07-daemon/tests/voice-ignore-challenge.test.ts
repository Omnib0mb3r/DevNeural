/**
 * BUG-047 / BUG-048 (2026-09-24), from the operator's evening test on the
 * Salem Road Trip brainstorm:
 *
 *  - "Thank you." was judged mid-thought by Smart Turn and held for the
 *    endpoint governor's whole ceiling before the voice saw it. The held-
 *    turn flush now uses the Smart Turn hold window (1.6 s default).
 *  - "Next in session." (whisper's rendering of "end session") got
 *    IGNORE: unclear address, i.e. silence, seconds after Lex's own line.
 *    The daemon now hands such words back to L1 as an [event] so it asks
 *    what he meant. This pins the pure decision.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  IGNORE_CHALLENGE_WINDOW_MS,
  _shouldChallengeIgnoreImpl,
  heldTurnFlushMaxHoldMs,
} from '../src/voice/lex-voice-ws.js';

describe('IGNORE challenge (BUG-048)', () => {
  it('challenges "unclear address" on real words seconds after the last exchange', () => {
    expect(_shouldChallengeIgnoreImpl('unclear address', 'Next in session.', 12_000)).toBe(true);
  });

  it('challenges any non-background reason, including a bare fragment', () => {
    expect(_shouldChallengeIgnoreImpl('fragment', 'the timer thing', 5_000)).toBe(true);
    expect(_shouldChallengeIgnoreImpl('not addressed', 'so anyway', 30_000)).toBe(true);
  });

  it('never challenges background categories', () => {
    for (const reason of [
      'background noise',
      'TV audio',
      'other person',
      'someone else',
      'own echo',
      'music playing',
      'dog barking',
    ]) {
      expect(_shouldChallengeIgnoreImpl(reason, 'and then we went', 3_000)).toBe(false);
    }
  });

  it("never challenges whisper's parenthetical noise tags", () => {
    expect(_shouldChallengeIgnoreImpl('unclear address', '(water bubbling)', 3_000)).toBe(false);
    expect(_shouldChallengeIgnoreImpl('unclear address', '[laughter]', 3_000)).toBe(false);
  });

  it('never challenges when the exchange is not live', () => {
    expect(_shouldChallengeIgnoreImpl('unclear address', 'Next in session.', null)).toBe(false);
    expect(
      _shouldChallengeIgnoreImpl('unclear address', 'Next in session.', IGNORE_CHALLENGE_WINDOW_MS + 1),
    ).toBe(false);
  });
});

describe('held-turn flush ceiling (BUG-047)', () => {
  const prior = process.env.DEVNEURAL_SMART_TURN_HOLD_MS;
  afterEach(() => {
    if (prior === undefined) delete process.env.DEVNEURAL_SMART_TURN_HOLD_MS;
    else process.env.DEVNEURAL_SMART_TURN_HOLD_MS = prior;
  });

  it('is the Smart Turn hold window, 1.6 s by default, never the 3 s governor ceiling', () => {
    delete process.env.DEVNEURAL_SMART_TURN_HOLD_MS;
    expect(heldTurnFlushMaxHoldMs()).toBe(1_600);
  });

  it('follows DEVNEURAL_SMART_TURN_HOLD_MS', () => {
    process.env.DEVNEURAL_SMART_TURN_HOLD_MS = '900';
    expect(heldTurnFlushMaxHoldMs()).toBe(900);
  });
});
