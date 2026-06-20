/**
 * Persona + digest + front-desk composition (pillar 3, sliver V7).
 *
 * Pins: digest push/get/freshness fail-safe; persona prompt is one-Lex
 * first-person with the worker as the only "he" and embeds the live
 * digest; the front desk composes control -> whitelist -> lane with the
 * digest-freshness gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pushDigest,
  getDigest,
  isDigestFresh,
  _resetDigest,
  type LexDigest,
} from '../src/voice/voice-digest.js';
import { buildHaikuPersonaPrompt } from '../src/voice/voice-persona.js';
import { frontDeskDecision } from '../src/voice/voice-frontdesk.js';

const DIGEST: LexDigest = {
  currentTask: 'pillar 3 voice build',
  lastDecision: 'haiku owns the mouth',
  openQuestion: 'none',
  workerStatus: 'the worker is idle',
  nextSteps: 'wire the WS capstone',
};

let priorFlag: string | undefined;

beforeEach(() => {
  priorFlag = process.env.DEVNEURAL_VOICE_HAIKU;
  _resetDigest();
});
afterEach(() => {
  if (priorFlag === undefined) delete process.env.DEVNEURAL_VOICE_HAIKU;
  else process.env.DEVNEURAL_VOICE_HAIKU = priorFlag;
  _resetDigest();
});

describe('Lex -> haiku digest', () => {
  it('push then get returns the digest + timestamp', () => {
    pushDigest(DIGEST, 5_000);
    expect(getDigest()?.digest.currentTask).toBe('pillar 3 voice build');
    expect(getDigest()?.ms).toBe(5_000);
  });

  it('fresh iff pushed at/after the last turn (Hole 2 fail-safe)', () => {
    expect(isDigestFresh(5_000)).toBe(false); // none pushed
    pushDigest(DIGEST, 5_000);
    expect(isDigestFresh(5_000)).toBe(true);
    expect(isDigestFresh(4_000)).toBe(true);
    expect(isDigestFresh(6_000)).toBe(false); // digest older than last turn
  });
});

describe('persona prompt', () => {
  it('is one-Lex first-person; worker is the only third-person actor', () => {
    const p = buildHaikuPersonaPrompt(DIGEST).toLowerCase();
    expect(p).toMatch(/first person/);
    expect(p).toMatch(/never refer to "lex"/);
    expect(p).toMatch(/third person/);
    expect(p).toMatch(/worker/);
    expect(p).toMatch(/only "he"/);
  });

  it('embeds the live digest as the source of fact', () => {
    const p = buildHaikuPersonaPrompt(DIGEST);
    expect(p).toContain('pillar 3 voice build');
    expect(p).toContain('haiku owns the mouth');
  });

  it('with no digest, instructs to queue factual turns', () => {
    const p = buildHaikuPersonaPrompt(null);
    expect(p.toLowerCase()).toMatch(/no digest yet/);
  });
});

describe('front desk composition', () => {
  it('control short-circuits regardless of digest', () => {
    const d = frontDeskDecision('quiet', { lastTurnMs: 1_000 });
    expect(d.route.lane).toBe('control');
  });

  it('glue + fresh digest -> fast lane', () => {
    pushDigest(DIGEST, 1_000);
    const d = frontDeskDecision('thanks', { lastTurnMs: 1_000 });
    expect(d.digestFresh).toBe(true);
    expect(d.route.lane).toBe('fast');
  });

  it('glue + stale digest -> slow lane (never answer off a stale digest)', () => {
    pushDigest(DIGEST, 500); // older than the turn
    const d = frontDeskDecision('thanks', { lastTurnMs: 1_000 });
    expect(d.digestFresh).toBe(false);
    expect(d.route.lane).toBe('slow');
  });

  it('a project/state question -> slow lane and carries the persona prompt', () => {
    pushDigest(DIGEST, 1_000);
    const d = frontDeskDecision('how many tests pass', { lastTurnMs: 1_000 });
    expect(d.route.lane).toBe('slow');
    expect(d.personaPrompt).toContain('pillar 3 voice build');
  });
});
