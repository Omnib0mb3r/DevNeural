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
import { matchPanicCommand, matchSpokenControl } from '../src/voice/lex-voice-commands.js';

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

/* BUG-030 (2026-09-22): the fixed operator controls are mechanical again,
 * prefix required, whole utterance, checked before Layer 1. */
describe('matchSpokenControl (BUG-030 word gate)', () => {
  it('matches the fixed verb set only with the lex prefix', () => {
    expect(matchSpokenControl('Lex mute.')).toBe('mute');
    expect(matchSpokenControl('lex, unmute')).toBe('unmute');
    expect(matchSpokenControl('Lex stand by')).toBe('standby');
    expect(matchSpokenControl('lex standby')).toBe('standby');
    expect(matchSpokenControl('Lex listen')).toBe('listen');
    expect(matchSpokenControl('lex end session')).toBe('end_session');
    expect(matchSpokenControl('Lex end the session')).toBe('end_session');
    expect(matchSpokenControl('lex stop talking')).toBe('stop_speaking');
    expect(matchSpokenControl('Lex be quiet')).toBe('stop_speaking');
  });
  it('ignores the verbs without the prefix and never eats substance', () => {
    expect(matchSpokenControl('mute the tv')).toBeNull();
    expect(matchSpokenControl('lex, can you mute the worker notifications')).toBeNull();
    expect(matchSpokenControl('lex emergency stop')).toBeNull();
    expect(matchSpokenControl('')).toBeNull();
  });
});
