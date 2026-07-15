/**
 * Notes/meeting mode name-gate (meeting-notes fixes 2026-07, task 2).
 *
 * isAddressedToLexInNotesMode() decides whether a notes-mode
 * utterance gets forwarded to Lex (PTY inject / direct-llm generate)
 * or only captured. Word-boundary "lex" plus either a trailing '?'
 * or an interrogative/imperative lead word shortly after "lex".
 */
import { describe, expect, it } from 'vitest';
import { isAddressedToLexInNotesMode } from '../src/voice/lex-voice-ws.js';

describe('isAddressedToLexInNotesMode', () => {
  describe('positives (addressed, with an ask)', () => {
    it('matches "lex what do you think"', () => {
      expect(isAddressedToLexInNotesMode('lex what do you think')).toBe(true);
    });

    it('matches "hey lex can you summarize"', () => {
      expect(
        isAddressedToLexInNotesMode('hey lex can you summarize'),
      ).toBe(true);
    });

    it('matches a trailing question mark even without a lead word in range', () => {
      expect(
        isAddressedToLexInNotesMode('lex are we still on track for friday?'),
      ).toBe(true);
    });

    it('matches "lex" plus an imperative verb ("tell", "summarize", "note")', () => {
      expect(isAddressedToLexInNotesMode('lex tell me the time')).toBe(true);
      expect(isAddressedToLexInNotesMode('lex note that down')).toBe(true);
    });

    it('is case-insensitive and tolerates punctuation', () => {
      expect(isAddressedToLexInNotesMode('Lex, what do you think?')).toBe(
        true,
      );
    });
  });

  describe('negatives (never forwarded)', () => {
    it('does NOT match "let\'s flex the schedule" (no word-boundary "lex")', () => {
      expect(isAddressedToLexInNotesMode("let's flex the schedule")).toBe(
        false,
      );
    });

    it('does NOT match plain discussion that never says "lex"', () => {
      expect(
        isAddressedToLexInNotesMode(
          'okay so the budget review moves to thursday',
        ),
      ).toBe(false);
    });

    it('does NOT match "lex" with no ask (mentioned, not addressed)', () => {
      expect(
        isAddressedToLexInNotesMode('lex is going to be here soon'),
      ).toBe(false);
      expect(isAddressedToLexInNotesMode('we talked to lex earlier')).toBe(
        false,
      );
    });

    it('does NOT match names that merely contain "lex" as a substring', () => {
      expect(isAddressedToLexInNotesMode('alexandra is joining late')).toBe(
        false,
      );
      expect(isAddressedToLexInNotesMode('the lexicon needs updating')).toBe(
        false,
      );
    });

    it('does NOT match empty or whitespace-only text', () => {
      expect(isAddressedToLexInNotesMode('')).toBe(false);
      expect(isAddressedToLexInNotesMode('   ')).toBe(false);
    });

    it('does NOT match a lead word that is far outside the token window', () => {
      const filler = 'um so anyway basically honestly look';
      expect(
        isAddressedToLexInNotesMode(`lex ${filler} what do you think`),
      ).toBe(false);
    });
  });
});
