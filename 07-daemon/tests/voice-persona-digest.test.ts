/**
 * Persona + digest composition (pillar 3, sliver V7; trimmed for spec
 * v2, 2026-07-15).
 *
 * Pins: digest push/get/freshness fail-safe; persona prompt is one-Lex
 * first-person with the worker as the only "he" and embeds the live
 * digest. The front-desk composition pins died with voice-frontdesk.ts
 * (spec-v2 teardown): the voice top layer owns routing now and carries
 * its own tests (voice-top-layer.test.ts).
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

  it('feeds the persona: pushed deriver output is fresh and embedded', () => {
    pushDigest(buildVoiceDigest('Shipped the digest push.'), 2_000);
    expect(isDigestFresh(2_000)).toBe(true);
    const p = buildHaikuPersonaPrompt(getDigest()?.digest ?? null);
    expect(p).toContain('Shipped the digest push.');
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

  /* 2026-07-16 fabrication fix: session 074b63b4 showed the talk model
   * recombining raw digest fragments ("fresh start" in lastDecision,
   * "Say it again?" as openQuestion, an empty last-line) into an
   * invented first-person memory claim spoken as Lex. The digest lines
   * must land contextualized as third-party WORK notes, and empty
   * fields must read as explicit absence, never as bare fragments. */
  it('renders empty digest fields as (none), never bare blanks', () => {
    const p = buildHaikuPersonaPrompt({
      currentTask: '',
      lastDecision: 'Pill fix committed, ten minutes after his fresh start.',
      openQuestion: '  ',
      workerStatus: '',
      nextSteps: '',
    });
    expect(p).toContain('Current task: (none)');
    expect(p).toContain('Open question: (none)');
    expect(p).toContain('Worker status: (none)');
    expect(p).toContain(
      'Pill fix committed, ten minutes after his fresh start.',
    );
  });

  it('contextualizes digest lines as work notes, never self-description', () => {
    const p = buildHaikuPersonaPrompt(DIGEST).toLowerCase();
    expect(p).toMatch(/status notes/);
    expect(p).toMatch(/not things you said/);
    expect(p).toMatch(/never (quote|echo)/);
  });
});

