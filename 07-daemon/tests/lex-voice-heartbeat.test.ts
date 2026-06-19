import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  heartbeatPhrase,
  shouldHeartbeat,
} from '../src/voice/lex-voice-heartbeat.js';

const base = {
  awaitingSince: 1_000,
  lastSpeechMs: 0,
  ttsActive: false,
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
  it('rotates and wraps without throwing on any counter value', () => {
    const a = heartbeatPhrase(0);
    const b = heartbeatPhrase(1);
    expect(a).not.toBe(b);
    expect(heartbeatPhrase(0)).toBe(heartbeatPhrase(4));
    expect(typeof heartbeatPhrase(-3)).toBe('string');
    expect(heartbeatPhrase(999).length).toBeGreaterThan(0);
  });
});
