/**
 * Panic keyword matcher (voice-top-layer teardown, 2026-07-15).
 *
 * "lex emergency stop" is the only mechanical voice keyword left.
 * Every other control (mute, end_session, standby, ...) is
 * interpreted by the voice top layer and fired through the dispatch
 * effects hub; those phrases must NOT fire here. The matcher runs on
 * raw user input because it reproduces the WS normalize step, so the
 * suite feeds it punctuation and casing noise directly.
 */
import { describe, expect, it } from 'vitest';
import { matchPanicCommand } from '../src/voice/lex-voice-commands.js';

describe('matchPanicCommand', () => {
  describe('fires on the panic phrase', () => {
    it('matches "lex emergency stop"', () => {
      expect(matchPanicCommand('lex emergency stop')).toBe(true);
    });

    it('matches with punctuation and casing noise', () => {
      expect(matchPanicCommand('Lex, Emergency Stop!')).toBe(true);
      expect(matchPanicCommand('LEX   EMERGENCY   STOP.')).toBe(true);
    });

    it('matches embedded inside a longer utterance', () => {
      expect(matchPanicCommand('okay lex emergency stop now please')).toBe(
        true,
      );
    });
  });

  describe('does not fire without the lex prefix', () => {
    it('rejects bare "emergency stop"', () => {
      expect(matchPanicCommand('emergency stop')).toBe(false);
      expect(matchPanicCommand('hit the emergency stop')).toBe(false);
    });
  });

  describe('does not fire on retired keyword-grammar phrases', () => {
    it('rejects "lex mute"', () => {
      expect(matchPanicCommand('lex mute')).toBe(false);
    });

    it('rejects "lex end session"', () => {
      expect(matchPanicCommand('lex end session')).toBe(false);
    });

    it('rejects the rest of the old grammar', () => {
      expect(matchPanicCommand('lex shut up')).toBe(false);
      expect(matchPanicCommand('lex unmute')).toBe(false);
      expect(matchPanicCommand('lex stand by')).toBe(false);
      expect(matchPanicCommand('lex listen')).toBe(false);
      expect(matchPanicCommand('lex disable')).toBe(false);
      expect(matchPanicCommand('lex hold up')).toBe(false);
      expect(matchPanicCommand('lex start project devneural')).toBe(false);
    });
  });

  describe('does not fire on ordinary speech', () => {
    it('rejects chatter that mentions lex', () => {
      expect(matchPanicCommand('lex what time is it')).toBe(false);
      expect(
        matchPanicCommand('I was just chatting with lex about the design'),
      ).toBe(false);
    });

    it('rejects chatter that mentions stopping', () => {
      expect(matchPanicCommand('please stop for a moment')).toBe(false);
      expect(matchPanicCommand('the build should stop on error')).toBe(false);
    });

    it('rejects empty and whitespace-only text', () => {
      expect(matchPanicCommand('')).toBe(false);
      expect(matchPanicCommand('   ')).toBe(false);
    });
  });
});
