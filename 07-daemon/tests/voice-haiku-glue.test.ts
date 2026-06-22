/**
 * Live haiku glue generation (DRIVE-QUEUE 1a). Pins the model seam: warm
 * replies come back trimmed, the model can absorb with <none>, errors
 * degrade to null (caller uses the deterministic fallback), phrasing
 * never repeats back-to-back, and the prompt is BF-4 safe (persona +
 * digest + the utterance only, never raw content).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateGlueReply,
  glueModelAvailable,
  renderReplyLive,
  _resetGlueHistory,
  type GlueModelCall,
} from '../src/voice/voice-haiku-glue.js';
import { _resetDigest, pushDigest } from '../src/voice/voice-digest.js';

let priorKey: string | undefined;
beforeEach(() => {
  priorKey = process.env.ANTHROPIC_API_KEY;
  _resetGlueHistory();
  _resetDigest();
});
afterEach(() => {
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = priorKey;
  _resetGlueHistory();
  _resetDigest();
});

describe('glueModelAvailable', () => {
  it('tracks the API key presence', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(glueModelAvailable()).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    expect(glueModelAvailable()).toBe(false);
  });
});

describe('generateGlueReply', () => {
  it('returns the model line, trimmed', async () => {
    const call: GlueModelCall = async () => '  glad that landed  ';
    const r = await generateGlueReply(
      { utterance: 'nice', hint: 'ack' },
      { call },
    );
    expect(r).toBe('glad that landed');
  });

  it('treats <none> as absorb (null)', async () => {
    const call: GlueModelCall = async () => '<none>';
    expect(
      await generateGlueReply({ utterance: 'ok', hint: 'ack' }, { call }),
    ).toBeNull();
  });

  it('returns null on an empty completion', async () => {
    const call: GlueModelCall = async () => '';
    expect(
      await generateGlueReply({ utterance: 'ok', hint: 'ack' }, { call }),
    ).toBeNull();
  });

  it('returns null when the call throws (caller falls back)', async () => {
    const call: GlueModelCall = async () => {
      throw new Error('timeout');
    };
    expect(
      await generateGlueReply({ utterance: 'louder', hint: 'louder' }, { call }),
    ).toBeNull();
  });

  it('rejects an exact back-to-back repeat (never the same phrasing twice)', async () => {
    const call: GlueModelCall = async () => 'same line';
    const first = await generateGlueReply(
      { utterance: 'ok', hint: 'ack' },
      { call },
    );
    expect(first).toBe('same line');
    const second = await generateGlueReply(
      { utterance: 'ok', hint: 'ack' },
      { call },
    );
    expect(second).toBeNull();
  });

  it('feeds recent replies back as an avoid-list for variation', async () => {
    const systems: string[] = [];
    const call: GlueModelCall = async ({ system }) => {
      systems.push(system);
      return `reply ${systems.length}`;
    };
    await generateGlueReply({ utterance: 'ok', hint: 'ack' }, { call });
    await generateGlueReply({ utterance: 'cool', hint: 'ack' }, { call });
    /* The first call had no history; the second must carry the first
     * reply in its avoid-list. */
    expect(systems[0]).not.toContain('Avoid repeating');
    expect(systems[1]).toContain('Avoid repeating');
    expect(systems[1]).toContain('reply 1');
  });

  it('BF-4: the prompt is persona + digest + utterance only', async () => {
    pushDigest(
      {
        currentTask: 'wiring the voice lane',
        lastDecision: 'live haiku for glue',
        openQuestion: 'none',
        workerStatus: 'idle',
        nextSteps: 'test it',
      },
      1,
    );
    let capturedSystem = '';
    let capturedUser = '';
    const call: GlueModelCall = async ({ system, user }) => {
      capturedSystem = system;
      capturedUser = user;
      return 'on it';
    };
    await generateGlueReply(
      { utterance: 'sounds good', hint: 'ack' },
      { call },
    );
    /* Persona framing + the synthesized digest are present; the user
     * message is exactly the utterance (no transcript, no raw content). */
    expect(capturedSystem).toContain('conscious voice of Lex');
    expect(capturedSystem).toContain('LIVE DIGEST');
    expect(capturedSystem).toContain('wiring the voice lane');
    expect(capturedSystem).toContain('VOICE FAST LANE');
    expect(capturedUser).toBe('sounds good');
  });

  it('passes the delivery hint through to the prompt', async () => {
    let system = '';
    const call: GlueModelCall = async (i) => {
      system = i.system;
      return 'easing off';
    };
    await generateGlueReply(
      { utterance: 'slow down', hint: 'slower' },
      { call },
    );
    expect(system.toLowerCase()).toContain('slow down');
  });
});

describe('renderReplyLive', () => {
  it('returns the restyled text and is BF-4 (persona + preserve + body only)', async () => {
    pushDigest(
      {
        currentTask: 'voice render wiring',
        lastDecision: 'live render',
        openQuestion: 'none',
        workerStatus: 'idle',
        nextSteps: 'ship',
      },
      1,
    );
    let system = '';
    let user = '';
    const call: GlueModelCall = async (i) => {
      system = i.system;
      user = i.user;
      return '1205 are green; holding off shipping.';
    };
    const out = await renderReplyLive(
      '1205 tests pass. Do not ship.',
      ['1205', 'not'],
      { call },
    );
    expect(out).toBe('1205 are green; holding off shipping.');
    expect(system).toContain('conscious voice of Lex');
    expect(system).toContain('SPOKEN RENDER');
    expect(system).toContain('voice render wiring');
    expect(system).toContain('1205');
    expect(system).toContain('renderer, not a re-thinker');
    /* the user message is exactly Lex's reply body - no raw transcript */
    expect(user).toBe('1205 tests pass. Do not ship.');
  });

  it('returns empty string when the call throws (caller ships safe render)', async () => {
    const call: GlueModelCall = async () => {
      throw new Error('timeout');
    };
    expect(await renderReplyLive('x', [], { call })).toBe('');
  });
});
