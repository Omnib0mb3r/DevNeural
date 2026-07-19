/**
 * Top-layer rethink-vs-finish policy (VOICE-BARGE-CLASSIFIER-SPEC §4,
 * VOICE-TOP-LAYER-SPEC point 6). On a barge mid-TTS the top layer
 * decides: FINISH (the input didn't change the answer -> resume /
 * finish the thought) or RETHINK (it did -> drop + forward). This
 * replaces the failSafeForward shape-check, which guessed "accidental"
 * from output shape instead of asking the model.
 */
import { describe, expect, it } from 'vitest';
import {
  parseTopLayerReply,
  topLayerTurn,
} from '../src/voice/voice-top-layer.js';

describe('parseTopLayerReply FINISH directive', () => {
  it('a bare FINISH line sets finish=true, no speech/forward/control', () => {
    const r = parseTopLayerReply('FINISH');
    expect(r.finish).toBe(true);
    expect(r.speech).toBeNull();
    expect(r.forward).toBeNull();
    expect(r.control).toBeNull();
  });

  it('accepts a trailing colon and is case/space insensitive', () => {
    expect(parseTopLayerReply('finish:').finish).toBe(true);
    expect(parseTopLayerReply('  Finish  ').finish).toBe(true);
  });

  it('no FINISH line leaves finish falsy (rethink is the default)', () => {
    const r = parseTopLayerReply('Let me rethink.\nFORWARD: switch to postgres');
    expect(r.finish).toBeFalsy();
    expect(r.forward).toBe('switch to postgres');
  });

  it('FINISH is the decision even if the model tacked on a stray word', () => {
    expect(parseTopLayerReply('FINISH\nokay').finish).toBe(true);
  });
});

describe('topLayerTurn rethink-vs-finish during TTS', () => {
  const askReturning =
    (reply: string | null) =>
    async (): Promise<string | null> =>
      reply;

  it('model returns FINISH -> result.finish true, nothing forwarded', async () => {
    const r = await topLayerTurn('yeah for sure', {
      lastSpoken: 'The daemon restarts in under ten seconds.',
      duringTts: true,
      lexBusy: false,
      deps: { ask: askReturning('FINISH') },
    });
    expect(r.finish).toBe(true);
    expect(r.forward).toBeNull();
  });

  it('a real change -> forwards (rethink), finish falsy', async () => {
    const r = await topLayerTurn('no wait, use postgres instead', {
      lastSpoken: 'I will set it up with sqlite.',
      duringTts: true,
      lexBusy: false,
      deps: {
        ask: askReturning('Let me rethink.\nFORWARD: switch the plan to postgres'),
      },
    });
    expect(r.finish).toBeFalsy();
    expect(r.forward).toContain('postgres');
  });

  it('FINISH is NOT clobbered by the all-null fail-safe into a forward', async () => {
    // A FINISH reply parses with speech/forward/control all null; the
    // fail-safe must not substitute forward=utterance over it.
    const r = await topLayerTurn('mm hm', {
      lastSpoken: 'so the fix keys off client playback.',
      duringTts: true,
      lexBusy: false,
      deps: { ask: askReturning('FINISH') },
    });
    expect(r.finish).toBe(true);
    expect(r.forward).toBeNull();
  });

  it('ask down (null reply) still fails safe to forward, never a phantom finish', async () => {
    const r = await topLayerTurn('do the migration', {
      lastSpoken: null,
      duringTts: true,
      lexBusy: false,
      deps: { ask: askReturning(null) },
    });
    expect(r.finish).toBeFalsy();
    expect(r.forward).toBe('do the migration');
  });
});
