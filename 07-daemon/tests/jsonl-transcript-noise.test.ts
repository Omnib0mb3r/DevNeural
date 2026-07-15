import { describe, expect, it } from 'vitest';
import { isNoiseTurn } from '../src/lex/jsonl-transcript-reader.js';

/**
 * 2026-07-09: cold-start seed polluted by supervision ticks.
 *
 * The 2-minute supervision watcher injects a big `[silent supervision
 * tick] Supervise ONLY ...` user turn each cycle; Lex answers each with
 * a bare ".". A night of that made the recent-thread tail read as ten
 * identical tick prompts + empty replies, so the cold-start seed taught
 * Lex nothing about the real conversation. isNoiseTurn drops both.
 */
describe('isNoiseTurn (cold-start recent-thread filter)', () => {
  it('drops the supervision tick user turn', () => {
    expect(
      isNoiseTurn(
        'user',
        '[silent supervision tick] Supervise ONLY the project bound to this brainstorm...',
      ),
    ).toBe(true);
  });

  it('drops awareness/heartbeat automated markers too', () => {
    expect(isNoiseTurn('user', '[awareness] worker idle 4m')).toBe(true);
    expect(isNoiseTurn('user', '[heartbeat] tick')).toBe(true);
  });

  it('drops the empty "." ack Lex answers a tick with', () => {
    expect(isNoiseTurn('lex', '.')).toBe(true);
    expect(isNoiseTurn('lex', '   ')).toBe(true);
    expect(isNoiseTurn('assistant', '')).toBe(true);
  });

  it('keeps real user turns, even bracketed voice-mode ones', () => {
    expect(isNoiseTurn('user', 'what is the academy worker doing?')).toBe(false);
    expect(isNoiseTurn('user', '[voice mode] good evening')).toBe(false);
  });

  it('keeps real Lex replies', () => {
    expect(isNoiseTurn('lex', 'The academy worker is parked at task 14.')).toBe(false);
  });
});
