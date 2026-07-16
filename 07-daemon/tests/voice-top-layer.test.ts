/**
 * Voice top layer v2 (speech-first, 2026-07-15). Pins the
 * FORWARD/CONTROL trailing-line parser, the fail-safe (an utterance is
 * never eaten), the never-twice ring on speech, and the ask plumbing
 * (system contract, persona/digest/local-time prompt, timeout
 * resolution). Every topLayerTurn here injects a fake ask; the real
 * voice-brain session is never loaded, let alone called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseTopLayerReply,
  topLayerTurn,
  type AskFn,
  type TopLayerControl,
  type TopLayerCtx,
} from '../src/voice/voice-top-layer.js';
import {
  _resetGlueHistory,
  rememberSpokenLine,
  wasLastSpoken,
} from '../src/voice/voice-haiku-glue.js';
import { _resetDigest, pushDigest } from '../src/voice/voice-digest.js';

const ALL_CONTROLS: TopLayerControl[] = [
  'mute',
  'unmute',
  'standby',
  'listen',
  'disable',
  'end_session',
  'stop_speaking',
  'interrupt_work',
];

const EMPTY = { speech: null, forward: null, control: null };

function makeCtx(
  ask: AskFn,
  over: Partial<Omit<TopLayerCtx, 'deps'>> = {},
  deps: Omit<NonNullable<TopLayerCtx['deps']>, 'ask'> = {},
): TopLayerCtx {
  return {
    lastSpoken: over.lastSpoken ?? null,
    duringTts: over.duringTts ?? false,
    lexBusy: over.lexBusy ?? false,
    deps: { ask, ...deps },
  };
}

let priorTimeoutEnv: string | undefined;
beforeEach(() => {
  priorTimeoutEnv = process.env.DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS;
  delete process.env.DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS;
  _resetGlueHistory();
  _resetDigest();
});
afterEach(() => {
  if (priorTimeoutEnv === undefined) {
    delete process.env.DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS;
  } else {
    process.env.DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS = priorTimeoutEnv;
  }
  _resetGlueHistory();
  _resetDigest();
});

describe('parseTopLayerReply', () => {
  it('plain text is speech, nothing else', () => {
    expect(
      parseTopLayerReply('Morning. Coffee first, then the daemon.'),
    ).toEqual({
      speech: 'Morning. Coffee first, then the daemon.',
      forward: null,
      control: null,
    });
  });

  it('multi-line plain text joins as speech and trims', () => {
    const r = parseTopLayerReply('First line.\nSecond line.\n');
    expect(r.speech).toBe('First line.\nSecond line.');
    expect(r.forward).toBeNull();
    expect(r.control).toBeNull();
  });

  it('speech plus a trailing FORWARD line', () => {
    const r = parseTopLayerReply(
      'Let me get my deeper brain on that.\n' +
        'FORWARD: why did the daemon restart at three this morning?',
    );
    expect(r).toEqual({
      speech: 'Let me get my deeper brain on that.',
      forward: 'why did the daemon restart at three this morning?',
      control: null,
    });
  });

  it('FORWARD matches case-insensitively with leading whitespace', () => {
    const r = parseTopLayerReply('  forward: check the ingest logs');
    expect(r.forward).toBe('check the ingest logs');
    expect(r.speech).toBeNull();
  });

  it('a FORWARD block spans following lines until the next directive', () => {
    const r = parseTopLayerReply(
      'On it.\n' +
        'FORWARD: check the daemon boot logs\n' +
        'and the last restart timestamp\n' +
        'CONTROL: mute',
    );
    expect(r.speech).toBe('On it.');
    expect(r.forward).toBe(
      'check the daemon boot logs\nand the last restart timestamp',
    );
    expect(r.control).toBe('mute');
  });

  it.each(ALL_CONTROLS)('CONTROL: %s parses as a control', (name) => {
    const r = parseTopLayerReply(`CONTROL: ${name}`);
    expect(r).toEqual({ speech: null, forward: null, control: name });
  });

  it('control token is lowercased and trimmed', () => {
    const r = parseTopLayerReply('Going quiet.\ncontrol:   MUTE  ');
    expect(r.control).toBe('mute');
    expect(r.speech).toBe('Going quiet.');
  });

  it('an invalid control token stays speech, never a control', () => {
    const r = parseTopLayerReply('CONTROL: self_destruct');
    expect(r.control).toBeNull();
    expect(r.forward).toBeNull();
    expect(r.speech).toBe('CONTROL: self_destruct');
  });

  it('a control line whose token has trailing words is speech', () => {
    const r = parseTopLayerReply('CONTROL: mute please');
    expect(r.control).toBeNull();
    expect(r.speech).toBe('CONTROL: mute please');
  });

  it('honors only the first valid control', () => {
    const r = parseTopLayerReply('CONTROL: mute\nCONTROL: unmute');
    expect(r.control).toBe('mute');
    expect(r.speech).toBeNull();
  });

  it('honors only the first forward block', () => {
    const r = parseTopLayerReply('FORWARD: first thing\nFORWARD: second thing');
    expect(r.forward).toBe('first thing');
    expect(r.speech).toBeNull();
  });

  it('null, undefined, empty, and whitespace parse to the empty result', () => {
    expect(parseTopLayerReply(null)).toEqual(EMPTY);
    expect(parseTopLayerReply(undefined)).toEqual(EMPTY);
    expect(parseTopLayerReply('')).toEqual(EMPTY);
    expect(parseTopLayerReply('   \n\t  \n')).toEqual(EMPTY);
  });

  it('caps speech at 500 chars', () => {
    const r = parseTopLayerReply('a'.repeat(650));
    expect(r.speech).toBe('a'.repeat(500));
  });

  it('speech at exactly 500 chars is untouched', () => {
    const r = parseTopLayerReply('b'.repeat(500));
    expect(r.speech).toBe('b'.repeat(500));
  });
});

describe('topLayerTurn', () => {
  it('assembles speech, forward, and control from the reply', async () => {
    const ask: AskFn = async () =>
      'On it, give me a beat.\nFORWARD: profile the ingest hot path';
    const r = await topLayerTurn(
      'can you profile the ingest hot path',
      makeCtx(ask),
    );
    expect(r).toEqual({
      speech: 'On it, give me a beat.',
      forward: 'profile the ingest hot path',
      control: null,
    });
  });

  it('a control-only reply is not fail-safed into a forward', async () => {
    const ask: AskFn = async () => 'CONTROL: stop_speaking';
    const r = await topLayerTurn('shut up a second', makeCtx(ask));
    expect(r).toEqual({
      speech: null,
      forward: null,
      control: 'stop_speaking',
    });
  });

  it('fail-safe: ask returning null forwards the utterance', async () => {
    const ask: AskFn = async () => null;
    const r = await topLayerTurn('remember to check the backlog', makeCtx(ask));
    expect(r).toEqual({
      speech: null,
      forward: 'remember to check the backlog',
      control: null,
    });
  });

  it('fail-safe: ask returning whitespace forwards the utterance', async () => {
    const ask: AskFn = async () => '   \n  ';
    const r = await topLayerTurn('what broke overnight', makeCtx(ask));
    expect(r).toEqual({
      speech: null,
      forward: 'what broke overnight',
      control: null,
    });
  });

  it('fail-safe: a throwing ask forwards the utterance, never throws', async () => {
    const ask: AskFn = async () => {
      throw new Error('session down');
    };
    const r = await topLayerTurn('kill the stuck worker', makeCtx(ask));
    expect(r).toEqual({
      speech: null,
      forward: 'kill the stuck worker',
      control: null,
    });
  });

  it('never-twice ring absorbs a back-to-back repeat of speech', async () => {
    const ask: AskFn = async () => 'Same line.';
    const first = await topLayerTurn('hi', makeCtx(ask));
    expect(first.speech).toBe('Same line.');
    const second = await topLayerTurn('hi again', makeCtx(ask));
    /* Absorbed, NOT fail-safe forwarded: the model did reply. */
    expect(second).toEqual(EMPTY);
  });

  it('ring suppression drops speech but keeps forward and control', async () => {
    const ask: AskFn = async () => 'On it.\nFORWARD: dig in\nCONTROL: mute';
    const first = await topLayerTurn('go', makeCtx(ask));
    expect(first.speech).toBe('On it.');
    const second = await topLayerTurn('go again', makeCtx(ask));
    expect(second).toEqual({ speech: null, forward: 'dig in', control: 'mute' });
  });

  it('registers fresh speech in the shared never-twice ring', async () => {
    const ask: AskFn = async () => 'Fresh line.';
    await topLayerTurn('hi', makeCtx(ask));
    expect(wasLastSpoken('Fresh line.')).toBe(true);
  });

  it('suppresses speech matching a line another path just spoke', async () => {
    rememberSpokenLine('Already said out loud.');
    const ask: AskFn = async () => 'Already said out loud.';
    const r = await topLayerTurn('hello', makeCtx(ask));
    expect(r.speech).toBeNull();
  });

  it('sends the contract as system and grounds the prompt', async () => {
    pushDigest(
      {
        currentTask: 'voice top layer rewrite',
        lastDecision: 'speech-first, no JSON',
        openQuestion: '',
        workerStatus: 'building',
        nextSteps: 'tests',
      },
      Date.now(),
    );
    let seen: { system: string; prompt: string; timeoutMs: number } | null =
      null;
    const ask: AskFn = async (args) => {
      seen = args;
      return 'ok';
    };
    await topLayerTurn(
      'what is the worker doing',
      makeCtx(
        ask,
        { lastSpoken: 'The tests are green.' },
        { now: () => new Date(2026, 6, 15, 14, 30) },
      ),
    );
    expect(seen).not.toBeNull();
    const { system, prompt } = seen!;
    expect(system).toContain('FORWARD:');
    expect(system).toContain(
      'mute unmute standby listen disable end_session stop_speaking interrupt_work',
    );
    expect(system).toContain('When in doubt: FORWARD.');
    /* Persona carries the digest as the only source of fact. */
    expect(prompt).toContain('voice top layer rewrite');
    /* Pinned clock lands as calibration, never spoken. */
    expect(prompt).toContain('14:30');
    expect(prompt).toContain('calibration only');
    /* Verbatim utterance and the last-spoken repeat anchor. */
    expect(prompt).toContain('what is the worker doing');
    expect(prompt).toContain('The tests are green.');
  });

  it('omits the last-spoken block when there is none', async () => {
    let prompt = '';
    const ask: AskFn = async (args) => {
      prompt = args.prompt;
      return 'ok';
    };
    await topLayerTurn('hi', makeCtx(ask));
    expect(prompt).not.toContain('Last line you spoke');
  });

  it('duringTts adds the echo note', async () => {
    let prompt = '';
    const ask: AskFn = async (args) => {
      prompt = args.prompt;
      return 'ok';
    };
    await topLayerTurn('stop', makeCtx(ask, { duringTts: true }));
    expect(prompt).toContain('WHILE you were speaking');
    expect(prompt).toContain('echo');
  });

  it('lexBusy adds the mid-task note', async () => {
    let prompt = '';
    const ask: AskFn = async (args) => {
      prompt = args.prompt;
      return 'ok';
    };
    await topLayerTurn('how is it going', makeCtx(ask, { lexBusy: true }));
    expect(prompt).toContain('mid-task');
    expect(prompt).toContain('FORWARD');
  });

  it('neither note appears on a plain turn', async () => {
    let prompt = '';
    const ask: AskFn = async (args) => {
      prompt = args.prompt;
      return 'ok';
    };
    await topLayerTurn('hi', makeCtx(ask));
    expect(prompt).not.toContain('WHILE you were speaking');
    expect(prompt).not.toContain('mid-task');
  });

  it('deps.timeoutMs overrides the timeout', async () => {
    let timeoutMs = 0;
    const ask: AskFn = async (args) => {
      timeoutMs = args.timeoutMs;
      return 'ok';
    };
    await topLayerTurn('hi', makeCtx(ask, {}, { timeoutMs: 99 }));
    expect(timeoutMs).toBe(99);
  });

  it('DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS sets the default timeout', async () => {
    process.env.DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS = '1234';
    let timeoutMs = 0;
    const ask: AskFn = async (args) => {
      timeoutMs = args.timeoutMs;
      return 'ok';
    };
    await topLayerTurn('hi', makeCtx(ask));
    expect(timeoutMs).toBe(1234);
  });

  it('defaults to 4000ms with the env unset', async () => {
    let timeoutMs = 0;
    const ask: AskFn = async (args) => {
      timeoutMs = args.timeoutMs;
      return 'ok';
    };
    await topLayerTurn('hi', makeCtx(ask));
    expect(timeoutMs).toBe(4000);
  });

  it('falls back to 4000ms on a garbage env value', async () => {
    process.env.DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS = 'soon';
    let timeoutMs = 0;
    const ask: AskFn = async (args) => {
      timeoutMs = args.timeoutMs;
      return 'ok';
    };
    await topLayerTurn('hi', makeCtx(ask));
    expect(timeoutMs).toBe(4000);
  });
});
