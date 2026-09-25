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
  MAX_SPEECH_CHARS,
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
  cut: null,
  pendingHandover: null,
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
    /* v3: the cap is a runaway guard (MAX_SPEECH_CHARS), not a style rule. */
    expect(parseTopLayerReply('x'.repeat(MAX_SPEECH_CHARS + 500)).speech).toHaveLength(
      MAX_SPEECH_CHARS,
    );
  });

  it('speechOnly strips every directive line', () => {
    expect(speechOnly('Right.\nFORWARD: x\nIGNORE: y\nCONTROL: mute')).toBe('Right.');
    expect(speechOnly('FORWARD: x')).toBe('');
  });
});

describe('worker and project effects (BUG-038)', () => {
  const VERBS = ['start_worker', 'stop_worker', 'panic_worker', 'switch_project'] as const;

  it('the four worker effects are verbs the parser accepts, with the project name as the argument', () => {
    for (const v of VERBS) expect(CONTROLS.has(v as never)).toBe(true);
    const r = parseTopLayerReply('Switching us over.\nCONTROL: switch_project drop ship');
    expect(r.speech).toBe('Switching us over.');
    expect(r.control).toBe('switch_project');
    expect(r.controlArg).toBe('drop ship');
    expect(parseTopLayerReply('On it.\nCONTROL: panic_worker').control).toBe('panic_worker');
  });

  it('the contract names them so the voice can map any wording onto them', () => {
    const p = buildTopLayerSystemPrompt();
    for (const v of VERBS) expect(p).toContain(v);
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

  it('tells the voice it holds no project facts (BUG-028)', () => {
    const p = buildTopLayerSystemPrompt();
    expect(p).toMatch(/hold no project facts/);
    /* 2026-09-24: a gap in the live block means "I am looking", never
     * "I don't know" and never a question back about the project. */
    expect(p).toMatch(/you are\s+already looking/);
    expect(p).toMatch(/Never "I don't have context"/);
    expect(p).toMatch(/give me a moment, I'm looking into it/);
  });

  it('answers a courtesy with a courtesy and never IGNOREs Michael\'s own voice (2026-09-24)', () => {
    const p = buildTopLayerSystemPrompt();
    /* "Thank you." got "Still on it, give me a moment." twice (BUG-047). */
    expect(p).toMatch(/A courtesy gets a courtesy/);
    expect(p).toMatch(/Never turn his thanks\s+into a status report/);
    /* "Next in session." (whisper's "end session") got IGNORE: unclear
     * address, i.e. silence (BUG-048). */
    expect(p).toMatch(/IGNORE is only for sound\s+that is not Michael talking to you/);
    expect(p).toMatch(/Unsure means ask, not silence/);
  });

  it('carries the warmup contract so a promptless session cannot pass warmup (BUG-041)', () => {
    const p = buildTopLayerSystemPrompt();
    expect(p).toContain('The daemon\'s boot probe is the exact message "Warmup check."');
    expect(p).toMatch(/Reply to\s+it with exactly LEX READY and nothing else/);
  });

  it('v3: directive shapes only, no scripted sentences; first person; no facts; barge policy; AI commands', () => {
    const p = buildTopLayerSystemPrompt();
    expect(p).toMatch(/Shapes \(what you heard -> the trailing lines/);
    expect(p).not.toMatch(/I can't see that from here/);
    expect(p).not.toMatch(/One moment, checking/);
    expect(p).toMatch(/his finished work is yours to report in the first person/);
    expect(p).toMatch(/never Claude Code/);
    expect(p).toMatch(/CONTROL: finish/);
    expect(p).toMatch(/CONTROL: answer_then_finish/);
    expect(p).toMatch(/Unsigned means rethink/);
    expect(p).toMatch(/whatever words he used/);
    expect(p).toMatch(/say how old/);
    /* The spoken warming line is gone; "give me a second" replaces it. */
    expect(p).not.toMatch(/still waking up/);
    expect(p).toMatch(/give me a second, go on/);
    /* Operator, 2026-09-22 evening: human speech, no names or symbols read
     * aloud; longer when it helps; challenge him; say when a deeper look
     * will take a while and keep him company meanwhile. */
    expect(p).toMatch(/never read a file name, a path, a symbol or code aloud/i);
    expect(p).toMatch(/longer explanation/);
    expect(p).toMatch(/better way/);
    expect(p).toMatch(/take a while/);
    expect(MAX_SPEECH_CHARS).toBeGreaterThanOrEqual(2400);
    for (const v of [
      'finish',
      'answer_then_finish',
      'slower',
      'faster',
      'louder',
      'softer',
      'start_over',
      'approve_handover',
      'reject_handover',
    ]) {
      expect(CONTROLS.has(v as never)).toBe(true);
    }
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

/* BUG-030 (2026-09-22): haiku narrated verbs instead of emitting the
 * directive ("Muted." with no CONTROL line, mic stayed live) and spoke a
 * stage direction aloud. The parser closes both gaps. */
describe('parser guards (BUG-030)', () => {
  it('a narrated verb with no directive becomes the control, flagged inferred', () => {
    const r = parseTopLayerReply('Muted.');
    expect(r.control).toBe('mute');
    expect(r.inferredControl).toBe(true);
    expect(parseTopLayerReply('Unmuted, go on.').control).toBe('unmute');
    expect(parseTopLayerReply('Standing by.').control).toBe('standby');
    expect(parseTopLayerReply('Listening.').control).toBe('listen');
    expect(parseTopLayerReply('Stopping. Over.').control).toBe('stop_speaking');
  });
  it('a real directive is never overridden and long speech is never inferred', () => {
    const r = parseTopLayerReply('Muted.\nCONTROL: standby');
    expect(r.control).toBe('standby');
    expect(r.inferredControl).toBeUndefined();
    expect(
      parseTopLayerReply(
        'Muted the notifications for the worker as you asked, and the rest stays live.',
      ).control,
    ).toBeNull();
  });
  it('parenthetical stage directions are never spoken', () => {
    expect(parseTopLayerReply('(Listening, not speaking.)').speech).toBeNull();
    expect(speechOnly('(pauses)\nRight, got it.')).toBe('Right, got it.');
    expect(parseTopLayerReply('Right (I think) so.').speech).toBe('Right (I think) so.');
  });
});
