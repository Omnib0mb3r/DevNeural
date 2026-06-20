/**
 * Heartbeat folded into the single mouth (pillar 3, sliver V6).
 *
 * Pins: grounded composition (first-person Lex; worker is the only "he");
 * the gate reuses the locked smart-heartbeat rules and adds a cross-source
 * mouth guard when haiku owns the mouth; flag-off is identical to the
 * existing gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  composeHeartbeat,
  shouldSpeakHeartbeatHaiku,
} from '../src/voice/voice-heartbeat-haiku.js';
import {
  shouldHeartbeat,
  type HeartbeatGate,
} from '../src/voice/lex-voice-heartbeat.js';
import { acquireMouth, _resetMouth } from '../src/voice/voice-mouth.js';

let prior: string | undefined;

beforeEach(() => {
  prior = process.env.DEVNEURAL_VOICE_HAIKU;
  _resetMouth();
});
afterEach(() => {
  if (prior === undefined) delete process.env.DEVNEURAL_VOICE_HAIKU;
  else process.env.DEVNEURAL_VOICE_HAIKU = prior;
  _resetMouth();
});

describe('composeHeartbeat (grounded persona)', () => {
  it('reports Lex deep-brain work in the first person (no third-person Lex)', () => {
    const line = composeHeartbeat({ lexElapsedMs: 5 * 60_000 });
    expect(line).toMatch(/still on it/i);
    expect(line).toMatch(/5 minutes/);
    expect(line.toLowerCase()).not.toContain('lex');
  });

  it('names the worker as the only third-person actor', () => {
    const line = composeHeartbeat({
      lexElapsedMs: 60_000,
      worker: { elapsedMs: 5 * 60_000 },
    });
    expect(line).toMatch(/worker/i);
    expect(line).toMatch(/5 minutes/);
  });

  it('handles sub-minute elapsed cleanly', () => {
    expect(composeHeartbeat({ lexElapsedMs: 10_000 })).toBe('Still on it.');
    expect(
      composeHeartbeat({ lexElapsedMs: 0, worker: { elapsedMs: 10_000 } }),
    ).toMatch(/just got going/);
  });

  it('singular minute', () => {
    expect(composeHeartbeat({ lexElapsedMs: 60_000 })).toMatch(/1 minute\b/);
  });
});

function gate(over: Partial<HeartbeatGate>): HeartbeatGate {
  return {
    awaitingSince: 1_000,
    lastSpeechMs: 0,
    ttsActive: false,
    userSpeaking: false,
    lastUserSpeechEndMs: 0,
    mode: 'conversation',
    now: 1_000 + 200_000,
    intervalMs: 120_000,
    ...over,
  };
}

describe('shouldSpeakHeartbeatHaiku (gate + mouth guard)', () => {
  it('flag OFF: identical to the locked smart-heartbeat gate', () => {
    delete process.env.DEVNEURAL_VOICE_HAIKU;
    const g = gate({});
    expect(shouldHeartbeat(g)).toBe(true);
    expect(shouldSpeakHeartbeatHaiku(g)).toBe(true);
    const gNo = gate({ userSpeaking: true });
    expect(shouldSpeakHeartbeatHaiku(gNo)).toBe(false);
  });

  it('flag ON + mouth held: never pulses even when the gate is open', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    const g = gate({});
    expect(shouldHeartbeat(g)).toBe(true);
    const grant = acquireMouth('lex')!; // someone holds the mouth
    expect(grant).not.toBeNull();
    expect(shouldSpeakHeartbeatHaiku(g)).toBe(false);
  });

  it('flag ON + mouth free: pulses when the gate is open', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    const g = gate({});
    expect(shouldSpeakHeartbeatHaiku(g)).toBe(true);
  });
});
