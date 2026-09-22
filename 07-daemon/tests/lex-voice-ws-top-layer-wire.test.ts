/**
 * Layer 1 wiring seams in the voice WS (LAYER-1-CONTROL.md v2). Pure,
 * module-level, pinned without a socket:
 *
 *   - _midStateImpl: what the [live] block says the brain (L2) is doing.
 *   - _planTopLayerActionsImpl: how a parsed L1 turn becomes daemon
 *     actions (speak / control / forward / queue-until-warm / ignore).
 *   - _shouldRecordCutAsFinalImpl: a cut delivery is never re-delivered
 *     (single-mouth invariant 6).
 */
import { describe, expect, it } from 'vitest';
import {
  _l2ComposerUpImpl,
  _midStateImpl,
  _planTopLayerActionsImpl,
  _shouldRecordCutAsFinalImpl,
  L2_WARM_MIN_UPTIME_MS,
  L2_WARM_QUIET_MS,
} from '../src/voice/lex-voice-ws.js';
import type { TopLayerResult } from '../src/voice/voice-top-layer.js';

describe('_midStateImpl', () => {
  const base = {
    hasBind: true,
    ptyAlive: true,
    awaitingSystemPrompt: false,
    seenAssistant: true,
    composerUp: false,
    ttsActive: false,
    awaitingResponseSince: 0,
    lastToolName: null as string | null,
    directLlm: false,
    directLlmInFlight: false,
  };

  it('composer up counts as warm even before the first assistant record (BUG-026)', () => {
    expect(_midStateImpl({ ...base, seenAssistant: false, composerUp: true }).mid).toBe('idle');
    expect(
      _midStateImpl({ ...base, seenAssistant: false, composerUp: true, awaitingResponseSince: 10 })
        .mid,
    ).toBe('thinking');
    expect(
      _midStateImpl({ ...base, seenAssistant: false, composerUp: true, awaitingSystemPrompt: true })
        .mid,
    ).toBe('warming');
  });

  it('down / warming / idle / thinking / tool / replying', () => {
    expect(_midStateImpl({ ...base, hasBind: false }).mid).toBe('down');
    expect(_midStateImpl({ ...base, ptyAlive: false }).mid).toBe('down');
    expect(_midStateImpl({ ...base, awaitingSystemPrompt: true }).mid).toBe('warming');
    expect(_midStateImpl({ ...base, seenAssistant: false }).mid).toBe('warming');
    expect(_midStateImpl(base)).toEqual({ mid: 'idle', sinceMs: null, tool: null });
    expect(_midStateImpl({ ...base, awaitingResponseSince: 10 })).toEqual({
      mid: 'thinking',
      sinceMs: 10,
      tool: null,
    });
    expect(
      _midStateImpl({ ...base, awaitingResponseSince: 10, lastToolName: 'Read' }),
    ).toEqual({ mid: 'tool', sinceMs: 10, tool: 'Read' });
    expect(_midStateImpl({ ...base, ttsActive: true }).mid).toBe('replying');
  });

  it('direct-llm binds have no PTY: thinking while a reply is in flight, else idle', () => {
    expect(
      _midStateImpl({ ...base, hasBind: false, directLlm: true, directLlmInFlight: true }).mid,
    ).toBe('thinking');
    expect(_midStateImpl({ ...base, hasBind: false, directLlm: true }).mid).toBe('idle');
  });
});

describe('_l2ComposerUpImpl (BUG-026)', () => {
  const up = {
    exited: false,
    awaitingSystemPrompt: false,
    startedAt: 0,
    lastActivity: 20_000,
    nowMs: 40_000,
  };
  it('is up once the PTY is old enough and its output has been quiet', () => {
    expect(_l2ComposerUpImpl(up)).toBe(true);
  });
  it('is not up during boot, while output still flows, on a native prompt, or after exit', () => {
    expect(_l2ComposerUpImpl({ ...up, nowMs: L2_WARM_MIN_UPTIME_MS - 1, lastActivity: 0 })).toBe(
      false,
    );
    expect(_l2ComposerUpImpl({ ...up, lastActivity: up.nowMs - L2_WARM_QUIET_MS + 1 })).toBe(false);
    expect(_l2ComposerUpImpl({ ...up, awaitingSystemPrompt: true })).toBe(false);
    expect(_l2ComposerUpImpl({ ...up, exited: true })).toBe(false);
  });
});

describe('_planTopLayerActionsImpl', () => {
  const r = (o: Partial<TopLayerResult>): TopLayerResult => ({
    speech: null,
    forward: null,
    control: null,
    controlArg: null,
    ignore: null,
    ...o,
  });

  it('ignore alone drops; ignore plus speech just speaks', () => {
    expect(_planTopLayerActionsImpl(r({ ignore: 'tv' }), false)).toEqual([
      { kind: 'ignore', reason: 'tv' },
    ]);
    expect(_planTopLayerActionsImpl(r({ ignore: 'tv', speech: 'Was that for me?' }), false)).toEqual([
      { kind: 'speak', text: 'Was that for me?' },
    ]);
  });

  it('forward routes now, or queues while the brain is warming', () => {
    expect(_planTopLayerActionsImpl(r({ forward: 'x' }), false)).toEqual([
      { kind: 'forward', text: 'x' },
    ]);
    expect(_planTopLayerActionsImpl(r({ forward: 'x' }), true)).toEqual([
      { kind: 'queue-until-warm', text: 'x' },
    ]);
  });

  it('speech first, then control, then forward (cancel + redirect keeps order)', () => {
    expect(
      _planTopLayerActionsImpl(r({ speech: 'ok', control: 'mute', controlArg: null }), false),
    ).toEqual([
      { kind: 'speak', text: 'ok' },
      { kind: 'control', control: 'mute', arg: null },
    ]);
    expect(
      _planTopLayerActionsImpl(
        r({ control: 'cancel_redirect', forward: 'new plan' }),
        false,
      ),
    ).toEqual([
      { kind: 'control', control: 'cancel_redirect', arg: null },
      { kind: 'forward', text: 'new plan' },
    ]);
    expect(
      _planTopLayerActionsImpl(r({ control: 'reject_plan', controlArg: 'too risky' }), false),
    ).toEqual([{ kind: 'control', control: 'reject_plan', arg: 'too risky' }]);
  });

  it('an all-null result (should not happen post fail-safe) plans nothing', () => {
    expect(_planTopLayerActionsImpl(r({}), false)).toEqual([]);
  });
});

describe('_shouldRecordCutAsFinalImpl', () => {
  it('a cut is final: never re-delivered, never spoken raw', () => {
    expect(_shouldRecordCutAsFinalImpl('cut')).toBe(true);
    expect(_shouldRecordCutAsFinalImpl('miss')).toBe(false);
    expect(_shouldRecordCutAsFinalImpl('delivered')).toBe(false);
  });
});
