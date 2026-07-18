/* SM-25 pins: smart stacking for top-layer voice turns.
 *
 * mergeOperatorUtterances is the combine step the coalesce loop uses
 * both for supersede (unspoken reply discarded, re-ask with all
 * utterances) and for boundary drain (queued utterances become one
 * combined follow-up turn). The serialization itself lives in
 * closure state (topTurnInFlight / pendingTopUtterances) exercised
 * live; these pin the message shape the voice brain receives. */
import { describe, it, expect } from 'vitest';
import { mergeOperatorUtterances } from '../src/voice/lex-voice-ws.js';

describe('mergeOperatorUtterances', () => {
  it('single utterance passes through untouched', () => {
    expect(mergeOperatorUtterances(['fix the login bug'])).toBe(
      'fix the login bug',
    );
  });

  it('combines two with the continuation frame on the second', () => {
    expect(
      mergeOperatorUtterances(['fix the login bug', 'also check the tests']),
    ).toBe(
      'fix the login bug\n(operator added before you replied): also check the tests',
    );
  });

  it('combines three in arrival order', () => {
    const merged = mergeOperatorUtterances(['a', 'b', 'c']);
    expect(merged.split('\n')).toEqual([
      'a',
      '(operator added before you replied): b',
      '(operator added before you replied): c',
    ]);
  });

  it('drops empty/whitespace parts instead of framing them', () => {
    expect(mergeOperatorUtterances(['  ', 'real words', ''])).toBe(
      'real words',
    );
  });

  it('empty input yields empty string (caller treats as no-op)', () => {
    expect(mergeOperatorUtterances([])).toBe('');
  });
});
