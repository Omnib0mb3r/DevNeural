import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enableVoiceHaiku, useVoiceHaiku } from '../src/voice/voice-haiku.js';

/**
 * 2026-09-23: the voice tier reads no API key (operator: subscription
 * sessions only, never the Anthropic API). The flag self-enables at boot
 * unless the operator opts out, and a key in the environment changes
 * nothing.
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

describe('useVoiceHaiku (strict flag gate)', () => {
  it('is on only when DEVNEURAL_VOICE_HAIKU is exactly "1"', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    expect(useVoiceHaiku()).toBe(true);
  });
  it('is off when unset, whatever keys sit in the environment', () => {
    process.env.BRIDGER_ANTHROPIC_API = 'sk-bridger';
    process.env.ANTHROPIC_API_KEY = 'sk-primary';
    expect(useVoiceHaiku()).toBe(false);
  });
});

describe('enableVoiceHaiku (daemon boot self-enable)', () => {
  it('turns the flag on in-process with no key at all', () => {
    expect(enableVoiceHaiku()).toBe(true);
    expect(process.env.DEVNEURAL_VOICE_HAIKU).toBe('1');
    expect(useVoiceHaiku()).toBe(true);
  });
  it('respects an explicit opt-out (=== "0")', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '0';
    expect(enableVoiceHaiku()).toBe(false);
    expect(process.env.DEVNEURAL_VOICE_HAIKU).toBe('0');
  });
  it('the module reads no key name at all', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '..', 'src', 'voice', 'voice-haiku.ts'), 'utf-8');
    expect(src).not.toMatch(/process\.env\.(ANTHROPIC_API_KEY|BRIDGER_ANTHROPIC_API)/);
  });
});
