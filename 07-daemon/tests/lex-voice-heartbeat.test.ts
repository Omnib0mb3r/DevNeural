import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_SPEECH_COOLDOWN_MS,
  heartbeatPhrase,
  shouldHeartbeat,
} from '../src/voice/lex-voice-heartbeat.js';

const base = {
  awaitingSince: 1_000,
  lastSpeechMs: 0,
  ttsActive: false,
  userSpeaking: false,
  lastUserSpeechEndMs: 0,
  mode: 'conversation',
  now: 1_000 + HEARTBEAT_INTERVAL_MS,
  intervalMs: HEARTBEAT_INTERVAL_MS,
};

describe('shouldHeartbeat', () => {
  it('fires after the silence threshold while a turn is in flight', () => {
    expect(shouldHeartbeat({ ...base })).toBe(true);
  });

  it('does not fire before the silence threshold', () => {
    expect(shouldHeartbeat({ ...base, now: 1_000 + HEARTBEAT_INTERVAL_MS - 1 })).toBe(
      false,
    );
  });

  it('does not fire when no turn is in flight', () => {
    expect(shouldHeartbeat({ ...base, awaitingSince: 0 })).toBe(false);
  });

  it('never fires while audio is already playing (no overlap)', () => {
    expect(shouldHeartbeat({ ...base, ttsActive: true })).toBe(false);
  });

  it('never fires while the user is speaking (half-duplex)', () => {
    expect(shouldHeartbeat({ ...base, userSpeaking: true })).toBe(false);
  });

  it('does not fire within the cooldown after the user stops speaking', () => {
    expect(
      shouldHeartbeat({ ...base, lastUserSpeechEndMs: base.now - 1 }),
    ).toBe(false);
  });

  it('fires once the cooldown after the user stops has elapsed', () => {
    expect(
      shouldHeartbeat({
        ...base,
        lastUserSpeechEndMs: base.now - HEARTBEAT_SPEECH_COOLDOWN_MS,
      }),
    ).toBe(true);
  });

  it('is suppressed in notes mode', () => {
    expect(shouldHeartbeat({ ...base, mode: 'notes' })).toBe(false);
  });

  it('measures silence from the most recent speech, not the inject', () => {
    // Spoke an ack recently; not silent long enough yet.
    const recentSpeech = base.now - 1_000;
    expect(shouldHeartbeat({ ...base, lastSpeechMs: recentSpeech })).toBe(false);
    // Same speech, but enough time has now elapsed.
    expect(
      shouldHeartbeat({
        ...base,
        lastSpeechMs: recentSpeech,
        now: recentSpeech + HEARTBEAT_INTERVAL_MS,
      }),
    ).toBe(true);
  });
});

describe('heartbeatPhrase', () => {
  it('reports the elapsed minutes honestly', () => {
    expect(heartbeatPhrase(120_000)).toBe(
      'Still working on this, about 2 minutes in.',
    );
  });

  it('uses the singular for a single minute', () => {
    expect(heartbeatPhrase(60_000)).toBe(
      'Still working on this, about 1 minute in.',
    );
  });

  it('never throws and always returns a non-empty string', () => {
    expect(typeof heartbeatPhrase(-3)).toBe('string');
    expect(heartbeatPhrase(0).length).toBeGreaterThan(0);
    expect(heartbeatPhrase(600_000).length).toBeGreaterThan(0);
  });
});
