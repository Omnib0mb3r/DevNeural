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
  renderReplyForSpeech,
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

  it('assumeDigestFresh keeps glue on the fast lane with no digest pushed', () => {
    /* No digest pushed (reset in beforeEach). The WS passes
     * assumeDigestFresh so deterministic glue stays answerable. */
    expect(
      haikuRoute('thanks', { lastTurnMs: 0, assumeDigestFresh: true })?.route
        .lane,
    ).toBe('fast');
    /* Without the override a missing digest pushes glue to slow. */
    expect(haikuRoute('thanks', { lastTurnMs: 1 })?.route.lane).toBe('slow');
  });

  it('a project question stays slow even with assumeDigestFresh', () => {
    expect(
      haikuRoute('how many tests pass', {
        lastTurnMs: 0,
        assumeDigestFresh: true,
      })?.route.lane,
    ).toBe('slow');
  });

  it('heartbeatLine is the grounded first-person line', () => {
    const line = heartbeatLine(5 * 60_000);
    expect(line.toLowerCase()).not.toContain('lex');
    expect(line).toMatch(/still on it/i);
  });
});

describe('composeGlueReply fallback (no model: byte-identical to prior canned glue)', () => {
  const off = { modelEnabled: false } as const;

  it('repeat replays the last spoken line verbatim', async () => {
    expect(
      await composeGlueReply('say that again', 'the build is green', off),
    ).toBe('the build is green');
  });

  it('empty replay returns the canned line', async () => {
    expect(await composeGlueReply('say that again', null, off)).toBe(
      'I had not said anything yet.',
    );
  });

  it('delivery tweaks ack', async () => {
    expect(await composeGlueReply('slower', null, off)).toBe('Slowing down.');
    expect(await composeGlueReply('louder', null, off)).toBe('Speaking up.');
    expect(await composeGlueReply('quieter', null, off)).toBe('Quieter.');
  });

  it('bare acknowledgments are absorbed (null = nothing spoken)', async () => {
    expect(await composeGlueReply('thanks', 'x', off)).toBeNull();
    expect(await composeGlueReply('yes', 'x', off)).toBeNull();
  });
});

describe('composeGlueReply live model path', () => {
  it('delivery tweak comes from the model, not the canned line', async () => {
    const seen: string[] = [];
    const reply = await composeGlueReply('slow down', null, {
      generate: async ({ hint }) => {
        seen.push(hint);
        return "sure, I'll ease off the pace";
      },
    });
    expect(reply).toBe("sure, I'll ease off the pace");
    expect(reply).not.toBe('Slowing down.');
    expect(seen).toEqual(['slower']);
  });

  it('bare ack can now get a warm reply instead of silence', async () => {
    const reply = await composeGlueReply('thanks', 'x', {
      generate: async ({ hint }) => {
        expect(hint).toBe('ack');
        return 'anytime';
      },
    });
    expect(reply).toBe('anytime');
  });

  it('model <none>/null on a tweak falls back to the deterministic line', async () => {
    const reply = await composeGlueReply('louder', null, {
      modelEnabled: true,
      generate: async () => null,
    });
    expect(reply).toBe('Speaking up.');
  });

  it('repeat stays a verbatim replay and never calls the model', async () => {
    let called = false;
    const reply = await composeGlueReply('say that again', 'forty two', {
      generate: async () => {
        called = true;
        return 'paraphrased';
      },
    });
    expect(reply).toBe('forty two');
    expect(called).toBe(false);
  });
});

describe('renderReplyForSpeech (live-haiku reply render)', () => {
  it('flag OFF: returns the reply verbatim (byte-identical)', async () => {
    delete process.env.DEVNEURAL_VOICE_HAIKU;
    const raw = '**1205** tests pass, do `not` ship';
    expect(await renderReplyForSpeech(raw)).toBe(raw);
  });

  it('flag ON + injected render: warms the reply, preserving numbers', async () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    const r = await renderReplyForSpeech('1205 tests pass.', {
      render: async () => '1205 tests are green.',
    });
    expect(r).toBe('1205 tests are green.');
  });

  it('flag ON + a render that drops a number falls back to the safe render', async () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    const r = await renderReplyForSpeech('1205 tests pass.', {
      render: async () => 'everything is green.',
    });
    expect(r).toContain('1205');
  });
});
