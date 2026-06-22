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
  buildVoiceDigest,
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

describe('buildVoiceDigest (DRIVE-QUEUE 1b deriver)', () => {
  it('derives lastDecision from the first sentence of the reply', () => {
    const d = buildVoiceDigest(
      'I landed the live glue. It varies every time now.',
    );
    expect(d.lastDecision).toBe('I landed the live glue.');
  });

  it('extracts the open question when the reply asks one', () => {
    const d = buildVoiceDigest('Did that build pass? I think so.');
    expect(d.openQuestion).toBe('Did that build pass?');
  });

  it('carries prior stable context forward across turns', () => {
    const prev: LexDigest = {
      currentTask: 'voice pillar',
      lastDecision: 'old',
      openQuestion: 'old q',
      workerStatus: 'worker mid-build',
      nextSteps: 'ship it',
    };
    const d = buildVoiceDigest('Renderer is wired.', prev);
    expect(d.currentTask).toBe('voice pillar');
    expect(d.workerStatus).toBe('worker mid-build');
    expect(d.nextSteps).toBe('ship it');
    expect(d.lastDecision).toBe('Renderer is wired.');
  });

  it('invents nothing without a prior digest (BF-4: reply text is the only input)', () => {
    const d = buildVoiceDigest('On it.');
    expect(d.currentTask).toBe('');
    expect(d.workerStatus).toBe('');
    expect(d.nextSteps).toBe('');
  });

  it('feeds the fast lane: pushed deriver output is fresh and in the persona', () => {
    pushDigest(buildVoiceDigest('Shipped the digest push.'), 2_000);
    expect(isDigestFresh(2_000)).toBe(true);
    const d = frontDeskDecision('nice', { lastTurnMs: 2_000 });
    expect(d.route.lane).toBe('fast');
    expect(d.personaPrompt).toContain('Shipped the digest push.');
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
