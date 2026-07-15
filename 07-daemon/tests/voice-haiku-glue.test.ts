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
let priorBridger: string | undefined;
beforeEach(() => {
  /* voiceApiKey() reads ANTHROPIC_API_KEY OR the BRIDGER fallback, so a
   * key-presence test must control both (the dev env carries a persistent
   * BRIDGER_ANTHROPIC_API). */
  priorKey = process.env.ANTHROPIC_API_KEY;
  priorBridger = process.env.BRIDGER_ANTHROPIC_API;
  delete process.env.BRIDGER_ANTHROPIC_API;
  _resetGlueHistory();
  _resetDigest();
});
afterEach(() => {
  if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = priorKey;
  if (priorBridger === undefined) delete process.env.BRIDGER_ANTHROPIC_API;
  else process.env.BRIDGER_ANTHROPIC_API = priorBridger;
  _resetGlueHistory();
  _resetDigest();
});

describe('glueModelAvailable', () => {
  it('tracks the API key presence (ANTHROPIC_API_KEY)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(glueModelAvailable()).toBe(true);
    delete process.env.ANTHROPIC_API_KEY;
    expect(glueModelAvailable()).toBe(false);
  });
  it('is available via the BRIDGER_ANTHROPIC_API fallback', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.BRIDGER_ANTHROPIC_API = 'sk-bridger';
    expect(glueModelAvailable()).toBe(true);
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

  /* DRIVE-QUEUE 1c: the render must never CUT a long reply. A genuinely
   * long reply (~2.5k chars) is what the old fixed 512-token cap cut off
   * mid-sentence. */
  const LONG = (
    'Here is the full status of the build. The migration landed and the ' +
    'daemon picked it up cleanly. The retrieval layer now returns pointer ' +
    'results for every project doc, and the voice tier speaks from the live ' +
    'digest on each turn. '
  ).repeat(7).trim();

  it('sizes max_tokens to the input so a long reply is not told to stop early', async () => {
    let seenMax = 0;
    const call: GlueModelCall = async (i) => {
      seenMax = i.maxTokens;
      return `${LONG} It is done.`;
    };
    await renderReplyLive(LONG, [], { call });
    /* Old fixed cap was 512 and cut this off; the cap must now exceed it
     * and comfortably cover the input's own token estimate. */
    expect(seenMax).toBeGreaterThan(512);
    expect(seenMax).toBeGreaterThanOrEqual(Math.ceil(LONG.length / 4));
  });

  it('drops a long restyle that does not end on a sentence boundary (cut)', async () => {
    /* Simulate a max_tokens cut: a long input, output stops mid-sentence. */
    const call: GlueModelCall = async () => `${LONG} and then it sudden`;
    const out = await renderReplyLive(LONG, [], { call });
    expect(out).toBe(''); // signals the caller to ship the full safe render
  });

  it('keeps a long restyle that completes on a sentence boundary', async () => {
    const call: GlueModelCall = async () => `${LONG} That is everything.`;
    const out = await renderReplyLive(LONG, [], { call });
    expect(out).toBe(`${LONG} That is everything.`);
  });

  it('does not over-trigger the completeness guard on short replies', async () => {
    /* A short reply may legitimately lack terminal punctuation. */
    const call: GlueModelCall = async () => 'on it';
    expect(await renderReplyLive('ok', [], { call })).toBe('on it');
  });
});
