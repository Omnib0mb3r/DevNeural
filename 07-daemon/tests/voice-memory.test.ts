/**
 * BUG-053 / BUG-050 (2026-09-25): the voice's working memory is per
 * anchor, not per socket, and the fail-safe forward never sends the
 * same words to the brain twice inside the window.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FAIL_SAFE_REPEAT_WINDOW_MS,
  _isRepeatFailSafeImpl,
  _rememberFailSafeImpl,
  _resetVoiceMemoryForTests,
  voiceMemoryFor,
} from '../src/voice/lex-voice-ws.js';

beforeEach(() => _resetVoiceMemoryForTests());

describe('voiceMemoryFor (BUG-053)', () => {
  it('is the same object for the same anchor across calls (a socket cycle loses nothing)', () => {
    const a = voiceMemoryFor('anchor-1');
    a.recentTalk.push({ heard: 'good morning', said: 'Morning.', atMs: 1 });
    a.lastSpokenText = 'Morning.';
    const again = voiceMemoryFor('anchor-1');
    expect(again).toBe(a);
    expect(again.recentTalk).toHaveLength(1);
    expect(again.lastSpokenText).toBe('Morning.');
  });

  it('keeps anchors apart and folds null, empty and blank keys onto one default', () => {
    voiceMemoryFor('anchor-1').lastSpokenText = 'one';
    expect(voiceMemoryFor('anchor-2').lastSpokenText).toBeNull();
    expect(voiceMemoryFor(null)).toBe(voiceMemoryFor(''));
    expect(voiceMemoryFor(undefined)).toBe(voiceMemoryFor('   '));
    expect(voiceMemoryFor(null)).not.toBe(voiceMemoryFor('anchor-1'));
  });
});

describe('fail-safe repeat guard (BUG-050)', () => {
  it('the same words again inside the window are a repeat, ignoring case and punctuation', () => {
    const m = voiceMemoryFor('a');
    _rememberFailSafeImpl(m, 'Good morning, Lex. How are you?', 10_000);
    expect(_isRepeatFailSafeImpl(m, 'good morning lex how are you', 20_000)).toBe(true);
    expect(_isRepeatFailSafeImpl(m, 'Good morning Lex, how are you?', 10_000 + FAIL_SAFE_REPEAT_WINDOW_MS - 1)).toBe(true);
  });

  it('different words, or the same words past the window, are not a repeat', () => {
    const m = voiceMemoryFor('a');
    _rememberFailSafeImpl(m, 'Good morning', 10_000);
    expect(_isRepeatFailSafeImpl(m, 'I did not hear you', 11_000)).toBe(false);
    expect(_isRepeatFailSafeImpl(m, 'Good morning', 10_000 + FAIL_SAFE_REPEAT_WINDOW_MS)).toBe(false);
    expect(_isRepeatFailSafeImpl(voiceMemoryFor('b'), 'Good morning', 11_000)).toBe(false);
  });
});
