/**
 * Voice top layer (Layer 1, LAYER-1-CONTROL.md v2, 2026-09-21).
 *
 * Pins the spawn-time L1 system prompt, the directive parser
 * (FORWARD / CONTROL / IGNORE trailing lines), the per-utterance turn
 * (streamed speech, fail-safe forward, silent ignore) and the L2 reply
 * delivery path. Every ask here is a fake; the real voice-brain session
 * is never loaded, let alone called.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONTROLS,
  buildTopLayerSystemPrompt,
  buildTopLayerTurnMessage,
  parseTopLayerReply,
  speechOnly,
  topLayerEventTurn,
  topLayerTurn,
  voiceLexReply,
  type AskFn,
  type LiveBlock,
} from '../src/voice/voice-top-layer.js';
import { LEX_PERSONA, LEX_SPOKEN_RULES } from '../src/lex/persona.js';
import { _resetGlueHistory } from '../src/voice/voice-haiku-glue.js';

const LIVE: LiveBlock = {
  mid: 'idle',
  midSinceMs: null,
  midTool: null,
  worker: null,
  lastSaid: null,
  digest: null,
  pendingPlan: null,
  pendingDispatch: null,
  nowMs: 0,
};

const EMPTY = { speech: null, forward: null, control: null, controlArg: null, ignore: null };

function ctx(ask: AskFn, onSpeech?: (line: string) => void) {
  return {
    live: LIVE,
    duringTts: false,
    anchorId: 'anchor-a',
    deps: { ask, onSpeech, timeoutMs: 100 },
  };
}

describe('parseTopLayerReply', () => {
  it('plain text is speech, nothing else', () => {
    expect(parseTopLayerReply('Morning. Coffee first.')).toEqual({
      ...EMPTY,
      speech: 'Morning. Coffee first.',
    });
  });

  it('FORWARD block spans lines, CONTROL carries an argument, IGNORE carries a reason', () => {
    const r = parseTopLayerReply(
      'On it.\nFORWARD: check the boot logs\nand the restart time\nCONTROL: reject_plan too risky tonight',
    );
    expect(r.speech).toBe('On it.');
    expect(r.forward).toBe('check the boot logs\nand the restart time');
    expect(r.control).toBe('reject_plan');
    expect(r.controlArg).toBe('too risky tonight');
    expect(r.ignore).toBeNull();
    expect(parseTopLayerReply('IGNORE: background tv')).toEqual({
      ...EMPTY,
      ignore: 'background tv',
    });
    expect(parseTopLayerReply('ignore:')).toEqual({ ...EMPTY, ignore: 'unspecified' });
  });

  it('matches directives case-insensitively with leading whitespace', () => {
    const r = parseTopLayerReply('  forward: run the tests\n  Control: MUTE');
    expect(r.forward).toBe('run the tests');
    expect(r.control).toBe('mute');
  });

  it('unknown CONTROL token stays speech; a second directive is stripped, first wins', () => {
    expect(parseTopLayerReply('CONTROL: dance').speech).toBe('CONTROL: dance');
    const r = parseTopLayerReply('CONTROL: mute\nCONTROL: unmute\nFORWARD: a\nFORWARD: b');
    expect(r.control).toBe('mute');
    expect(r.forward).toBe('a');
    expect(r.speech).toBeNull();
  });

  it('every verb in the contract parses', () => {
    for (const verb of CONTROLS) {
      expect(parseTopLayerReply(`CONTROL: ${verb}`).control).toBe(verb);
    }
    expect(CONTROLS.has('drop_reply')).toBe(true);
    expect(CONTROLS.has('combine')).toBe(true);
    expect(CONTROLS.has('cancel_redirect')).toBe(true);
    expect(CONTROLS.has('confirm_dispatch')).toBe(true);
  });

  it('null / empty parses to the all-null result; speech is capped', () => {
    expect(parseTopLayerReply(null)).toEqual(EMPTY);
    expect(parseTopLayerReply('   ')).toEqual(EMPTY);
    expect(parseTopLayerReply('x'.repeat(2_000)).speech).toHaveLength(600);
  });

  it('speechOnly strips every directive line', () => {
    expect(speechOnly('Right.\nFORWARD: x\nIGNORE: y\nCONTROL: mute')).toBe('Right.');
    expect(speechOnly('FORWARD: x')).toBe('');
  });
});

describe('buildTopLayerSystemPrompt', () => {
  it('carries the shared persona, the spoken rules and the contract', () => {
    const p = buildTopLayerSystemPrompt();
    expect(p).toContain(LEX_PERSONA);
    expect(p).toContain(LEX_SPOKEN_RULES);
    for (const s of [
      'FORWARD:',
      'CONTROL:',
      'IGNORE:',
      'cancel_redirect',
      'drop_reply',
      'combine',
      'approve_plan',
      'confirm_dispatch',
      'sparring partner',
      'warming',
      'brain-progress',
    ]) {
      expect(p).toContain(s);
    }
    expect(p).not.toContain('never reference earlier messages');
    expect(p).not.toMatch(/—|–/);
    /* Seamless: the layer vocabulary is for the contract, never spoken. */
    expect(p).toContain('Out loud there is only one of you');
  });
});

describe('topLayerTurn', () => {
  beforeEach(() => _resetGlueHistory());

  it('fail-safe: a null ask forwards the utterance verbatim and never ignores', async () => {
    const r = await topLayerTurn('deploy the thing', ctx(async () => null));
    expect(r).toEqual({ ...EMPTY, forward: 'deploy the thing' });
  });

  it('a thrown ask also fail-safes', async () => {
    const r = await topLayerTurn(
      'hello',
      ctx(async () => {
        throw new Error('boom');
      }),
    );
    expect(r.forward).toBe('hello');
  });

  it('sends the live block and the utterance, on the anchor, with no per-ask system framing', async () => {
    let seen: Parameters<AskFn>[0] | null = null;
    const ask: AskFn = async (a) => {
      seen = a;
      return 'Sure.';
    };
    await topLayerTurn('what now', ctx(ask));
    expect(seen!.anchorId).toBe('anchor-a');
    expect(seen!.system).toBeUndefined();
    expect(seen!.noLivenessStrike).toBe(true);
    expect(seen!.prompt).toBe(
      buildTopLayerTurnMessage('what now', LIVE, { duringTts: false, words: 2 }),
    );
  });

  it('streams speech per record with directives stripped, then reports no remainder', async () => {
    const spoken: string[] = [];
    const ask: AskFn = async (a) => {
      a.onPartial?.('Sure thing.\nFORWARD: run the tests');
      return 'Sure thing.\nFORWARD: run the tests';
    };
    const r = await topLayerTurn('run the tests', ctx(ask, (l) => spoken.push(l)));
    expect(spoken).toEqual(['Sure thing.']);
    expect(r.speech).toBeNull();
    expect(r.forward).toBe('run the tests');
  });

  it('without a speech sink the parsed speech comes back for the caller to speak', async () => {
    const r = await topLayerTurn('morning', ctx(async () => 'Morning. Coffee first.'));
    expect(r.speech).toBe('Morning. Coffee first.');
    expect(r.forward).toBeNull();
  });

  it('IGNORE with no speech is the silent drop', async () => {
    const r = await topLayerTurn(
      'turn the lights off honey',
      ctx(async () => 'IGNORE: not addressed to me'),
    );
    expect(r).toEqual({ ...EMPTY, ignore: 'not addressed to me' });
  });

  it('a control with a forward keeps both (cancel + redirect)', async () => {
    const r = await topLayerTurn(
      'no stop, do the other thing',
      ctx(async () => 'Dropping that.\nCONTROL: cancel_redirect\nFORWARD: do the other thing'),
    );
    expect(r.speech).toBe('Dropping that.');
    expect(r.control).toBe('cancel_redirect');
    expect(r.forward).toBe('do the other thing');
  });
});

describe('topLayerEventTurn', () => {
  it('never fail-safe-forwards an event; a null ask is silence', async () => {
    const r = await topLayerEventTurn(
      { kind: 'brain-progress', text: 'thinking 40s' },
      ctx(async () => null),
    );
    expect(r).toEqual(EMPTY);
  });

  it('speaks the event line the model produced', async () => {
    const spoken: string[] = [];
    const ask: AskFn = async (a) => {
      a.onPartial?.('Still reading the schema, about forty seconds in.');
      return 'Still reading the schema, about forty seconds in.';
    };
    const r = await topLayerEventTurn(
      { kind: 'brain-progress', text: 'tool Read 40s' },
      ctx(ask, (l) => spoken.push(l)),
    );
    expect(spoken).toEqual(['Still reading the schema, about forty seconds in.']);
    expect(r.speech).toBeNull();
  });
});

describe('voiceLexReply (TTS hooked only to the top layer)', () => {
  beforeEach(() => _resetGlueHistory());

  it('streams the delivery through onSpeech and reports delivered', async () => {
    const spoken: string[] = [];
    const ask: AskFn = async (args) => {
      args.onPartial?.('The build passed.');
      args.onPartial?.('Three of three tests are green.');
      return 'The build passed.\nThree of three tests are green.';
    };
    const delivered = await voiceLexReply('build: 3/3 pass', {
      onSpeech: (l) => spoken.push(l),
      deps: { ask },
    });
    expect(delivered).toBe('delivered');
    expect(spoken).toEqual(['The build passed.', 'Three of three tests are green.']);
  });

  it('passes the anchor through to the ask', async () => {
    let seen: Parameters<AskFn>[0] | null = null;
    const ask: AskFn = async (a) => {
      seen = a;
      return 'ok';
    };
    await voiceLexReply('body', { onSpeech: () => undefined, anchorId: 'anchor-z', deps: { ask } });
    expect(seen!.anchorId).toBe('anchor-z');
    expect(seen!.system).toMatch(/deliver/i);
  });

  it('falls back to the resolved text when no partials stream', async () => {
    const spoken: string[] = [];
    const ask: AskFn = async () => 'Delivered as one block.';
    const delivered = await voiceLexReply('body', {
      onSpeech: (l) => spoken.push(l),
      deps: { ask },
    });
    expect(delivered).toBe('delivered');
    expect(spoken).toEqual(['Delivered as one block.']);
  });

  it('reports a miss on null so the caller speaks the raw body', async () => {
    const ask: AskFn = async () => null;
    const delivered = await voiceLexReply('body', {
      onSpeech: () => undefined,
      deps: { ask },
    });
    expect(delivered).toBe('miss');
  });

  it('reports a miss on a throwing ask, never throws itself', async () => {
    const ask: AskFn = async () => {
      throw new Error('session died');
    };
    const delivered = await voiceLexReply('body', {
      onSpeech: () => undefined,
      deps: { ask },
    });
    expect(delivered).toBe('miss');
  });

  it('an empty body is trivially delivered (nothing to speak)', async () => {
    const spoken: string[] = [];
    const delivered = await voiceLexReply('   ', {
      onSpeech: (l) => spoken.push(l),
      deps: { ask: async () => 'never called' },
    });
    expect(delivered).toBe('delivered');
    expect(spoken).toEqual([]);
  });

  it('a directive-shaped delivery is treated as a miss, not spoken', async () => {
    const spoken: string[] = [];
    const ask: AskFn = async () => 'FORWARD: do not speak directives';
    const delivered = await voiceLexReply('body', {
      onSpeech: (l) => spoken.push(l),
      deps: { ask },
    });
    expect(delivered).toBe('miss');
    expect(spoken).toEqual([]);
  });
});
