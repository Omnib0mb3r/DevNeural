/**
 * Haiku voice talk-layer scaffold (pillar 3, sliver V1).
 *
 * Pins the flag + model config the rest of the pillar builds on. Default
 * OFF; model defaults to Anthropic Haiku, env-overridable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  useVoiceHaiku,
  voiceHaikuConfig,
  VOICE_HAIKU_MODEL,
} from '../src/voice/voice-haiku.js';

let priorFlag: string | undefined;

beforeEach(() => {
  priorFlag = process.env.DEVNEURAL_VOICE_HAIKU;
});

afterEach(() => {
  if (priorFlag === undefined) delete process.env.DEVNEURAL_VOICE_HAIKU;
  else process.env.DEVNEURAL_VOICE_HAIKU = priorFlag;
});

describe('voice-haiku config', () => {
  it('is OFF by default', () => {
    delete process.env.DEVNEURAL_VOICE_HAIKU;
    expect(useVoiceHaiku()).toBe(false);
    expect(voiceHaikuConfig().enabled).toBe(false);
  });

  it('is ON when the flag is exactly "1"', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    expect(useVoiceHaiku()).toBe(true);
    expect(voiceHaikuConfig().enabled).toBe(true);
  });

  it('treats any non-"1" value as off', () => {
    process.env.DEVNEURAL_VOICE_HAIKU = 'true';
    expect(useVoiceHaiku()).toBe(false);
  });

  it('defaults the talk-layer model to Anthropic Haiku', () => {
    expect(VOICE_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001');
    expect(voiceHaikuConfig().model).toBe('claude-haiku-4-5-20251001');
  });
});
