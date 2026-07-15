import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  voiceApiKey,
  useVoiceHaiku,
  enableVoiceHaikuIfKeyPresent,
} from '../src/voice/voice-haiku.js';

/**
 * 2026-07-09: voice fell back to flat hardcoded lines because the daemon
 * had no ANTHROPIC_API_KEY (start-daemon.ps1's env block is skipped on a
 * manual `node dist/daemon.js` restart). voiceApiKey() now also reads the
 * persistent BRIDGER_ANTHROPIC_API, and useVoiceHaiku() auto-enables when
 * a key is present, so the smart lane no longer depends on the launcher.
 */
const KEYS = ['ANTHROPIC_API_KEY', 'BRIDGER_ANTHROPIC_API', 'DEVNEURAL_VOICE_HAIKU'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('voiceApiKey', () => {
  it('prefers ANTHROPIC_API_KEY when set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-primary';
    process.env.BRIDGER_ANTHROPIC_API = 'sk-bridger';
    expect(voiceApiKey()).toBe('sk-primary');
  });
  it('falls back to BRIDGER_ANTHROPIC_API', () => {
    process.env.BRIDGER_ANTHROPIC_API = 'sk-bridger';
    expect(voiceApiKey()).toBe('sk-bridger');
  });
  it('is undefined when neither is set', () => {
    expect(voiceApiKey()).toBeUndefined();
  });
});

describe('useVoiceHaiku (strict flag gate)', () => {
  it('is on only when DEVNEURAL_VOICE_HAIKU is exactly "1"', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    expect(useVoiceHaiku()).toBe(true);
  });
  it('is off when unset, even with a key present (pure gate)', () => {
    process.env.BRIDGER_ANTHROPIC_API = 'sk-bridger';
    expect(useVoiceHaiku()).toBe(false);
  });
});

describe('enableVoiceHaikuIfKeyPresent (daemon boot self-enable)', () => {
  it('turns the flag on in-process when a key is present and flag unset', () => {
    process.env.BRIDGER_ANTHROPIC_API = 'sk-bridger';
    expect(enableVoiceHaikuIfKeyPresent()).toBe(true);
    expect(process.env.DEVNEURAL_VOICE_HAIKU).toBe('1');
    expect(useVoiceHaiku()).toBe(true);
  });
  it('leaves the flag off when no key is present', () => {
    expect(enableVoiceHaikuIfKeyPresent()).toBe(false);
    expect(process.env.DEVNEURAL_VOICE_HAIKU).toBeUndefined();
  });
  it('respects an explicit opt-out (=== "0") even with a key', () => {
    process.env.BRIDGER_ANTHROPIC_API = 'sk-bridger';
    process.env.DEVNEURAL_VOICE_HAIKU = '0';
    expect(enableVoiceHaikuIfKeyPresent()).toBe(false);
    expect(process.env.DEVNEURAL_VOICE_HAIKU).toBe('0');
  });
});
