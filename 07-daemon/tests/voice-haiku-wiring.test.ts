/**
 * Haiku wiring (pillar 3 capstone).
 *
 * The regression guard: with the flag OFF every helper is a passthrough,
 * so the live voice path is byte-identical. With it ON they route through
 * the front desk / renderer / heartbeat.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  renderForSpeech,
  haikuRoute,
  heartbeatLine,
  composeGlueReply,
} from '../src/voice/voice-haiku-wiring.js';
import { heartbeatPhrase } from '../src/voice/lex-voice-heartbeat.js';
import { _resetDigest } from '../src/voice/voice-digest.js';

let prior: string | undefined;
beforeEach(() => {
  prior = process.env.DEVNEURAL_VOICE_HAIKU;
  _resetDigest();
});
afterEach(() => {
  if (prior === undefined) delete process.env.DEVNEURAL_VOICE_HAIKU;
  else process.env.DEVNEURAL_VOICE_HAIKU = prior;
  _resetDigest();
});

describe('flag OFF: byte-identical passthrough (regression guard)', () => {
  beforeEach(() => {
    delete process.env.DEVNEURAL_VOICE_HAIKU;
  });

  it('renderForSpeech returns the text verbatim (no rendering applied)', () => {
    const raw = '**1205** tests pass, do `not` ship';
    expect(renderForSpeech(raw)).toBe(raw);
  });

  it('haikuRoute returns null so the WS keeps its existing path', () => {
    expect(haikuRoute('how many tests pass', { lastTurnMs: 0 })).toBeNull();
    expect(haikuRoute('quiet', { lastTurnMs: 0 })).toBeNull();
  });

  it('heartbeatLine is exactly the existing phrase', () => {
    expect(heartbeatLine(5 * 60_000)).toBe(heartbeatPhrase(5 * 60_000));
  });
});

describe('flag ON: routes through the haiku layer', () => {
  beforeEach(() => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
  });

  it('renderForSpeech strips markdown but preserves numbers/negations', () => {
    const r = renderForSpeech('**1205** tests pass, do `not` ship');
    expect(r).not.toContain('**');
    expect(r).toContain('1205');
    expect(r).toMatch(/\bnot\b/);
  });

  it('haikuRoute returns a front-desk decision', () => {
    const d = haikuRoute('quiet', { lastTurnMs: 0 });
    expect(d?.route.lane).toBe('control');
    const s = haikuRoute('how many tests pass', { lastTurnMs: 0 });
    expect(s?.route.lane).toBe('slow');
  });

  it('heartbeatLine is the grounded first-person line', () => {
    const line = heartbeatLine(5 * 60_000);
    expect(line.toLowerCase()).not.toContain('lex');
    expect(line).toMatch(/still on it/i);
  });
});

describe('composeGlueReply (fast lane, deterministic)', () => {
  it('repeat replays the last spoken line', () => {
    expect(composeGlueReply('say that again', 'the build is green')).toBe(
      'the build is green',
    );
  });

  it('delivery tweaks ack', () => {
    expect(composeGlueReply('slower', null)).toBe('Slowing down.');
    expect(composeGlueReply('louder', null)).toBe('Speaking up.');
  });

  it('bare acknowledgments are absorbed (null = nothing spoken)', () => {
    expect(composeGlueReply('thanks', 'x')).toBeNull();
    expect(composeGlueReply('yes', 'x')).toBeNull();
  });
});
