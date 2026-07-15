/**
 * Haiku wiring (pillar 3 capstone).
 *
 * The regression guard: with the flag OFF every helper is a passthrough,
 * so the live voice path is byte-identical. With it ON they route through
 * the front desk / renderer / heartbeat.
 *
 * 2026-07-15 rework: composeGlueReply's smart path (greetings AND general
 * glue asides) is now askText on the persistent Max-plan judge session
 * (src/lex/judge-session.ts), not a metered Haiku call. These tests mock
 * judge-session.js wholesale - the same ROUTING-test pattern
 * tests/inject-verdict-judge-routing.test.ts and
 * tests/expectation-supervisor-judge-routing.test.ts use - so no real
 * `claude` process is ever touched; judge-session.ts's own internals
 * (timeout/respawn/serialization) are covered by tests/judge-session.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lex/judge-session.js', () => ({
  askText: vi.fn(),
}));

import {
  renderForSpeech,
  haikuRoute,
  heartbeatLine,
  composeGlueReply,
  composeBridgeReply,
  renderReplyForSpeech,
  isGreetingAside,
} from '../src/voice/voice-haiku-wiring.js';
import { heartbeatPhrase } from '../src/voice/lex-voice-heartbeat.js';
import { _resetDigest, pushDigest } from '../src/voice/voice-digest.js';
import { _resetGlueHistory } from '../src/voice/voice-haiku-glue.js';
import { askText } from '../src/lex/judge-session.js';

let prior: string | undefined;
let priorTimeout: string | undefined;
beforeEach(() => {
  prior = process.env.DEVNEURAL_VOICE_HAIKU;
  priorTimeout = process.env.DEVNEURAL_GLUE_ASK_TIMEOUT_MS;
  _resetDigest();
  _resetGlueHistory();
  vi.mocked(askText).mockReset();
});
afterEach(() => {
  if (prior === undefined) delete process.env.DEVNEURAL_VOICE_HAIKU;
  else process.env.DEVNEURAL_VOICE_HAIKU = prior;
  if (priorTimeout === undefined) delete process.env.DEVNEURAL_GLUE_ASK_TIMEOUT_MS;
  else process.env.DEVNEURAL_GLUE_ASK_TIMEOUT_MS = priorTimeout;
  _resetDigest();
  _resetGlueHistory();
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

describe('composeGlueReply: silence guard (askText null/unavailable - the tiny fallback pool)', () => {
  beforeEach(() => {
    vi.mocked(askText).mockResolvedValue(null);
  });

  it('repeat replays the last spoken line verbatim, without ever calling askText', async () => {
    expect(
      await composeGlueReply('say that again', 'the build is green'),
    ).toBe('the build is green');
    expect(askText).not.toHaveBeenCalled();
  });

  it('empty replay (askText null) returns the deterministic canned line', async () => {
    expect(await composeGlueReply('say that again', null)).toBe(
      "I haven't said anything yet.",
    );
  });

  it('delivery tweaks fall back to the deterministic ack', async () => {
    expect(await composeGlueReply('slower', null)).toBe('Slowing down.');
    expect(await composeGlueReply('louder', null)).toBe('Speaking up.');
    expect(await composeGlueReply('quieter', null)).toBe('Going quieter.');
  });

  it('bare acknowledgments are absorbed (null = nothing spoken)', async () => {
    expect(await composeGlueReply('thanks', 'x')).toBeNull();
    expect(await composeGlueReply('yes', 'x')).toBeNull();
  });

  it('askText throwing is treated the same as null (never throws out of composeGlueReply)', async () => {
    vi.mocked(askText).mockRejectedValue(new Error('judge session unavailable'));
    expect(await composeGlueReply('louder', null)).toBe('Speaking up.');
  });
});

describe('composeGlueReply: askText is the primary path (the smart path)', () => {
  it('a delivery tweak comes from askText, not the canned line', async () => {
    vi.mocked(askText).mockResolvedValue("sure, I'll ease off the pace");
    const reply = await composeGlueReply('slow down', null);
    expect(reply).toBe("sure, I'll ease off the pace");
    expect(reply).not.toBe('Slowing down.');
  });

  it('a bare ack can now get a warm reply instead of silence', async () => {
    vi.mocked(askText).mockResolvedValue('anytime');
    expect(await composeGlueReply('thanks', 'x')).toBe('anytime');
  });

  it('a null askText reply on a tweak falls back to the deterministic line', async () => {
    vi.mocked(askText).mockResolvedValue(null);
    expect(await composeGlueReply('louder', null)).toBe('Speaking up.');
  });

  it('repeat with nothing said yet asks askText first, then falls back on a miss', async () => {
    vi.mocked(askText).mockResolvedValue('nothing yet, but go ahead');
    expect(await composeGlueReply('say that again', null)).toBe(
      'nothing yet, but go ahead',
    );

    vi.mocked(askText).mockResolvedValue(null);
    _resetGlueHistory();
    expect(await composeGlueReply('say that again', null)).toBe(
      "I haven't said anything yet.",
    );
  });

  it('a repeat with a real last-spoken line never calls askText (verbatim replay only)', async () => {
    vi.mocked(askText).mockResolvedValue('paraphrased instead');
    const reply = await composeGlueReply('say that again', 'forty two');
    expect(reply).toBe('forty two');
    expect(askText).not.toHaveBeenCalled();
  });

  it('an exact back-to-back repeat of the last spoken line is rejected (never-twice ring)', async () => {
    vi.mocked(askText).mockResolvedValue('glad that landed');
    const first = await composeGlueReply('nice', 'x');
    expect(first).toBe('glad that landed');

    /* Same reply again: the ring rejects it, so the deterministic guard
     * (null = absorb, for a bare ack) fires instead of an echo. */
    vi.mocked(askText).mockResolvedValue('glad that landed');
    const second = await composeGlueReply('nice', 'x');
    expect(second).toBeNull();
  });
});

describe('composeGlueReply: greetings via askText (persistent-session smart greeting)', () => {
  it('prefers askText over the guard, using whatever it says verbatim', async () => {
    vi.mocked(askText).mockResolvedValue(
      "morning - the migration's still holding steady, ready when you are",
    );
    const reply = await composeGlueReply('good morning', null);
    expect(reply).toBe(
      "morning - the migration's still holding steady, ready when you are",
    );
  });

  it('falls back to the two-line neutral guard when askText is null - no correction logic', async () => {
    vi.mocked(askText).mockResolvedValue(null);
    const morning = () => new Date(2026, 0, 1, 8, 0, 0);
    expect(await composeGlueReply('good morning', null, { now: morning })).toBe(
      'Morning.',
    );

    _resetGlueHistory();
    vi.mocked(askText).mockResolvedValue(null);
    const night = () => new Date(2026, 0, 1, 23, 0, 0);
    expect(await composeGlueReply('good morning', null, { now: night })).toBe(
      'Hey.',
    );
  });

  it('the guard never repeats the immediately-previous line back-to-back', async () => {
    vi.mocked(askText).mockResolvedValue(null);
    const morning = () => new Date(2026, 0, 1, 8, 0, 0);
    const first = await composeGlueReply('good morning', null, { now: morning });
    const second = await composeGlueReply('good morning', null, { now: morning });
    expect(first).toBe('Morning.');
    expect(second).not.toBe(first);
    expect(second).toBe('Hey.');
  });

  it('non-greeting asides are unaffected by the greeting guard', async () => {
    vi.mocked(askText).mockResolvedValue(null);
    expect(await composeGlueReply('thanks', 'x')).toBeNull();
    expect(await composeGlueReply('slower', null)).toBe('Slowing down.');
  });
});

describe('composeGlueReply: askText prompt contract', () => {
  it('the timeout defaults to 4000ms', async () => {
    vi.mocked(askText).mockResolvedValue('hi there');
    await composeGlueReply('hello', null);
    expect(vi.mocked(askText).mock.calls[0]![0].timeoutMs).toBe(4000);
  });

  it('DEVNEURAL_GLUE_ASK_TIMEOUT_MS overrides the default', async () => {
    process.env.DEVNEURAL_GLUE_ASK_TIMEOUT_MS = '1500';
    vi.mocked(askText).mockResolvedValue('hi there');
    await composeGlueReply('hello', null);
    expect(vi.mocked(askText).mock.calls[0]![0].timeoutMs).toBe(1500);
  });

  it('a deps.timeoutMs override wins over the env var', async () => {
    process.env.DEVNEURAL_GLUE_ASK_TIMEOUT_MS = '1500';
    vi.mocked(askText).mockResolvedValue('hi there');
    await composeGlueReply('hello', null, { timeoutMs: 900 });
    expect(vi.mocked(askText).mock.calls[0]![0].timeoutMs).toBe(900);
  });

  it('carries the persona line in system and the aside verbatim in prompt', async () => {
    vi.mocked(askText).mockResolvedValue('hi there');
    await composeGlueReply('good morning, hows the migration going', null);
    const call = vi.mocked(askText).mock.calls[0]![0];
    expect(call.system).toContain('You are Lex');
    expect(call.prompt).toContain(
      '"good morning, hows the migration going"',
    );
  });

  it('carries lastDecision/openQuestion from the live digest when present', async () => {
    pushDigest(
      {
        currentTask: 'wiring the voice lane',
        lastDecision: 'moved glue onto the persistent session',
        openQuestion: 'still deciding the guard pool size',
        workerStatus: 'idle',
        nextSteps: 'ship it',
      },
      1,
    );
    vi.mocked(askText).mockResolvedValue('hi there');
    await composeGlueReply('good morning', null);
    const call = vi.mocked(askText).mock.calls[0]![0];
    expect(call.prompt).toContain('moved glue onto the persistent session');
    expect(call.prompt).toContain('still deciding the guard pool size');
  });

  it('omits digest lines gracefully when no digest has landed yet', async () => {
    vi.mocked(askText).mockResolvedValue('hi there');
    await composeGlueReply('good morning', null);
    const call = vi.mocked(askText).mock.calls[0]![0];
    expect(call.prompt).not.toMatch(/Last decision:/);
    expect(call.prompt).not.toMatch(/Open question:/);
  });

  it('instructs the model to use the clock only as calibration and never mention the time', async () => {
    vi.mocked(askText).mockResolvedValue('hi there');
    await composeGlueReply('good morning', null, {
      now: () => new Date(2026, 0, 1, 8, 0, 0),
    });
    const call = vi.mocked(askText).mock.calls[0]![0];
    expect(call.prompt).toMatch(/calibration only/i);
    expect(call.prompt).toMatch(/never mention the time/i);
    /* The actual clock value is present so the model CAN calibrate, but
     * it is explicitly told not to speak it. */
    expect(call.prompt).toContain('08:00');
  });

  it('passes the last spoken line as an explicit avoid, and omits it when there is none', async () => {
    vi.mocked(askText).mockResolvedValue('hi there');
    await composeGlueReply('thanks', 'the build is green');
    const withLast = vi.mocked(askText).mock.calls[0]![0];
    expect(withLast.prompt).toContain('Never repeat this line');
    expect(withLast.prompt).toContain('the build is green');

    vi.mocked(askText).mockClear();
    vi.mocked(askText).mockResolvedValue('hi there');
    await composeGlueReply('thanks', null);
    const withoutLast = vi.mocked(askText).mock.calls[0]![0];
    expect(withoutLast.prompt).not.toContain('Never repeat this line');
  });
});

describe('composeGlueReply / composeBridgeReply: the metered path is retired', () => {
  it('composeGlueReply never calls the deprecated generateGlueReply', async () => {
    const glueModule = await import('../src/voice/voice-haiku-glue.js');
    const spy = vi.spyOn(glueModule, 'generateGlueReply');

    vi.mocked(askText).mockResolvedValue('a reply');
    await composeGlueReply('good morning', null);
    await composeGlueReply('slower', null);
    await composeGlueReply('thanks', 'x');

    vi.mocked(askText).mockResolvedValue(null);
    await composeGlueReply('good afternoon', null);
    await composeGlueReply('say that again', null);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('composeBridgeReply stays deterministic: never calls generateBridgeReply, always returns the fallback', async () => {
    const glueModule = await import('../src/voice/voice-haiku-glue.js');
    const spy = vi.spyOn(glueModule, 'generateBridgeReply');

    const out = await composeBridgeReply('what is the worker doing', 'one sec');
    expect(out).toBe('one sec');
    expect(spy).not.toHaveBeenCalled();
    expect(askText).not.toHaveBeenCalled();
    spy.mockRestore();
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

  /* DRIVE-QUEUE 1c regression: a long reply must speak to completion. When
   * the render signals a cut (returns ''), the FULL safe render ships, not
   * a truncated sentence. */
  it('flag ON: a long reply speaks in full when the render is cut', async () => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
    const longReply =
      'First, the migration landed and the daemon picked it up. ' +
      'Second, the retrieval layer returns pointer results for every doc. ' +
      'Third, the voice tier now speaks from the live digest each turn. ' +
      'Finally, the remaining work is the slow-lane bridge and a richer digest.';
    const r = await renderReplyForSpeech(longReply, {
      /* renderReplyLive returns '' on a detected cut; emulate that. */
      render: async () => '',
    });
    /* The whole reply is spoken (safe render), tail included. */
    expect(r).toContain('slow-lane bridge');
    expect(r).toContain('First, the migration landed');
  });
});

describe('isGreetingAside (whole-utterance greeting matcher)', () => {
  it('matches greeting phrases, case-insensitively and normalized', () => {
    expect(isGreetingAside('good morning')).toBe(true);
    expect(isGreetingAside('Good Morning')).toBe(true);
    expect(isGreetingAside('  good   morning  ')).toBe(true);
    expect(isGreetingAside('good morning.')).toBe(true);
    expect(isGreetingAside('morning')).toBe(true);
    expect(isGreetingAside('good afternoon')).toBe(true);
    expect(isGreetingAside('good evening')).toBe(true);
    expect(isGreetingAside('hello')).toBe(true);
    expect(isGreetingAside('hey lex')).toBe(true);
    expect(isGreetingAside('hi')).toBe(true);
  });

  it('does not match a substantive turn that merely mentions a greeting word', () => {
    expect(isGreetingAside('good morning, what did the tests do overnight')).toBe(false);
  });

  it('does not match non-greeting glue or control turns', () => {
    expect(isGreetingAside('thanks')).toBe(false);
    expect(isGreetingAside('quiet')).toBe(false);
    expect(isGreetingAside('slower')).toBe(false);
  });
});

describe('haikuRoute: greeting always answers on the fast lane (requirement 3/4)', () => {
  beforeEach(() => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
  });

  it('routes a greeting to fast even with no digest ever pushed (cold start)', () => {
    const d = haikuRoute('good morning', { lastTurnMs: 1 });
    expect(d?.route.lane).toBe('fast');
  });

  it('routes a greeting to fast even when a digest exists but is stale', () => {
    pushDigest(
      {
        currentTask: '',
        lastDecision: '',
        openQuestion: '',
        workerStatus: '',
        nextSteps: '',
      },
      1,
    );
    const d = haikuRoute('hello', { lastTurnMs: 100 });
    expect(d?.route.lane).toBe('fast');
  });

  it('routes a greeting to fast when the digest is fresh too', () => {
    const d = haikuRoute('good afternoon', {
      lastTurnMs: 0,
      assumeDigestFresh: true,
    });
    expect(d?.route.lane).toBe('fast');
  });

  it('a non-greeting substantive turn still queues (staleness gate untouched)', () => {
    const d = haikuRoute('how many tests pass', { lastTurnMs: 1 });
    expect(d?.route.lane).toBe('slow');
  });

  it('a non-greeting substantive turn still queues even with assumeDigestFresh', () => {
    const d = haikuRoute('how many tests pass', {
      lastTurnMs: 0,
      assumeDigestFresh: true,
    });
    expect(d?.route.lane).toBe('slow');
  });

  it('control commands are unaffected by the greeting override', () => {
    expect(haikuRoute('quiet', { lastTurnMs: 0 })?.route.lane).toBe('control');
  });
});
