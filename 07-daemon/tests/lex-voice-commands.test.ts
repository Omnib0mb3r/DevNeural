/**
 * Lex voice-command suite matcher.
 *
 * Every command must start with the word "lex" so meeting chatter
 * cannot false-fire. Match precedence is fixed: panic > end_session
 * > mute > unmute > disable so that "lex stop talking" lands on the
 * mute kind rather than tripping a "lex stop" prefix that older
 * documentation referenced. "lex resume" is reserved for a future
 * broader command and MUST NOT match unmute today.
 */
import { describe, expect, it } from 'vitest';
import { matchVoiceCommand } from '../src/voice/lex-voice-commands.js';

describe('matchVoiceCommand', () => {
  describe('panic', () => {
    it('matches "lex emergency stop"', () => {
      expect(matchVoiceCommand('lex emergency stop')).toEqual({ kind: 'panic' });
    });

    it('matches with punctuation and casing', () => {
      expect(matchVoiceCommand('Lex, Emergency Stop!')).toEqual({
        kind: 'panic',
      });
    });

    it('matches embedded inside a longer utterance', () => {
      expect(
        matchVoiceCommand('okay lex emergency stop now please'),
      ).toEqual({ kind: 'panic' });
    });

    it('does NOT match "emergency stop" without the lex prefix', () => {
      expect(matchVoiceCommand('emergency stop')).toBeNull();
    });
  });

  describe('end_session', () => {
    it('matches "lex end session"', () => {
      expect(matchVoiceCommand('lex end session')).toEqual({
        kind: 'end_session',
      });
    });

    it('matches with casing and punctuation', () => {
      expect(matchVoiceCommand('Lex, end session.')).toEqual({
        kind: 'end_session',
      });
    });

    it('does NOT match "end session" without the lex prefix', () => {
      expect(matchVoiceCommand('end session')).toBeNull();
      expect(matchVoiceCommand('please end this session')).toBeNull();
    });
  });

  describe('mute family', () => {
    it('matches "lex mute"', () => {
      expect(matchVoiceCommand('lex mute')).toEqual({ kind: 'mute' });
    });

    it('matches "lex shut up"', () => {
      expect(matchVoiceCommand('lex shut up')).toEqual({ kind: 'mute' });
    });

    it('matches "lex be quiet"', () => {
      expect(matchVoiceCommand('lex be quiet')).toEqual({ kind: 'mute' });
    });

    it('matches "lex stop talking"', () => {
      expect(matchVoiceCommand('lex stop talking')).toEqual({ kind: 'mute' });
    });

    it('matches with casing and punctuation', () => {
      expect(matchVoiceCommand('Lex, shut up!')).toEqual({ kind: 'mute' });
      expect(matchVoiceCommand('LEX  BE  QUIET.')).toEqual({ kind: 'mute' });
    });

    it('"lex stop talking" falls through to mute, not disable', () => {
      const m = matchVoiceCommand('lex stop talking');
      expect(m).not.toBeNull();
      expect(m!.kind).toBe('mute');
      expect(m!.kind).not.toBe('disable');
    });

    it('does NOT match bare "mute" without the lex prefix', () => {
      expect(matchVoiceCommand('mute')).toBeNull();
      expect(matchVoiceCommand('be quiet')).toBeNull();
      expect(matchVoiceCommand('stop talking')).toBeNull();
    });
  });

  describe('unmute family', () => {
    it('matches "lex unmute"', () => {
      expect(matchVoiceCommand('lex unmute')).toEqual({ kind: 'unmute' });
    });

    it('matches "lex resume" synonym (Fix 10 regression)', () => {
      /* The bug that motivated Fix 10: "lex resume" used to fall
       * through and the user had to press stop+start to recover
       * TTS after a mute. */
      expect(matchVoiceCommand('lex resume')).toEqual({ kind: 'unmute' });
      expect(matchVoiceCommand('Lex resume!')).toEqual({ kind: 'unmute' });
    });

    it('matches "lex come back"', () => {
      expect(matchVoiceCommand('lex come back')).toEqual({ kind: 'unmute' });
    });

    it('matches "lex you can talk"', () => {
      expect(matchVoiceCommand('lex you can talk')).toEqual({ kind: 'unmute' });
    });

    it('matches "lex start talking again"', () => {
      expect(matchVoiceCommand('lex start talking again')).toEqual({
        kind: 'unmute',
      });
    });

    it('matches with casing and punctuation', () => {
      expect(matchVoiceCommand('Lex, unmute.')).toEqual({ kind: 'unmute' });
    });

    it('does NOT match bare "unmute" / "resume"', () => {
      expect(matchVoiceCommand('unmute')).toBeNull();
      expect(matchVoiceCommand('resume')).toBeNull();
    });

    it('"lex resume listening" lands on listen, NOT unmute', () => {
      /* Disambiguation: bare "lex resume" is unmute (TTS axis), but
       * the qualified "lex resume listening" is the STT-axis listen
       * command. */
      expect(matchVoiceCommand('lex resume listening')).toEqual({
        kind: 'listen',
      });
    });
  });

  describe('standby family (Fix 10A soft mic pause)', () => {
    it('matches "lex stand by"', () => {
      expect(matchVoiceCommand('lex stand by')).toEqual({ kind: 'standby' });
    });

    it('matches "lex pause listening"', () => {
      expect(matchVoiceCommand('lex pause listening')).toEqual({
        kind: 'standby',
      });
    });

    it('matches "lex hold on"', () => {
      expect(matchVoiceCommand('lex hold on')).toEqual({ kind: 'standby' });
    });

    it('does NOT match bare "stand by" / "hold on"', () => {
      expect(matchVoiceCommand('stand by')).toBeNull();
      expect(matchVoiceCommand('hold on')).toBeNull();
    });
  });

  describe('listen family (Fix 10A mic rearm after standby)', () => {
    it('matches "lex listen"', () => {
      expect(matchVoiceCommand('lex listen')).toEqual({ kind: 'listen' });
    });

    it('matches "lex resume listening"', () => {
      expect(matchVoiceCommand('lex resume listening')).toEqual({
        kind: 'listen',
      });
    });

    it("matches \"lex i'm back\"", () => {
      expect(matchVoiceCommand("lex i'm back")).toEqual({ kind: 'listen' });
    });

    it('does NOT match bare "listen"', () => {
      expect(matchVoiceCommand('listen')).toBeNull();
    });
  });

  describe('disable', () => {
    it('matches "lex disable"', () => {
      expect(matchVoiceCommand('lex disable')).toEqual({ kind: 'disable' });
    });

    it('matches with casing and punctuation', () => {
      expect(matchVoiceCommand('Lex, disable!')).toEqual({ kind: 'disable' });
    });

    it('does NOT match bare "disable"', () => {
      expect(matchVoiceCommand('disable')).toBeNull();
    });

    it('does NOT match bare "lex stop" (legacy phrasing removed)', () => {
      expect(matchVoiceCommand('lex stop')).toBeNull();
    });
  });

  describe('non-commands', () => {
    it('returns null on empty / whitespace text', () => {
      expect(matchVoiceCommand('')).toBeNull();
      expect(matchVoiceCommand('   ')).toBeNull();
    });

    it('returns null on ordinary speech that mentions lex', () => {
      expect(matchVoiceCommand('lex what time is it')).toBeNull();
      expect(
        matchVoiceCommand('I was just chatting with lex about the design'),
      ).toBeNull();
    });

    it('returns null when the lex prefix is absent', () => {
      expect(matchVoiceCommand('disable the worker')).toBeNull();
      expect(matchVoiceCommand('please be quiet for a moment')).toBeNull();
    });
  });
});
