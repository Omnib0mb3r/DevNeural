/**
 * Two lanes (pillar 3.2, sliver V4).
 *
 * Pins: control short-circuits before lane classification; glue -> fast
 * (no bridge, no Opus); facts -> slow (carries a bridge line); a stale
 * digest pushes glue onto the slow lane.
 */
import { describe, expect, it } from 'vitest';
import { routeTurn, pickBridgeLine } from '../src/voice/voice-lane-router.js';

describe('lane router', () => {
  it('control utterances route to the control lane (never data)', () => {
    const d = routeTurn('quiet');
    expect(d.lane).toBe('control');
    expect(d.control?.action).toBe('kill-tts');
    const r = routeTurn('actually, switch to postgres');
    expect(r.lane).toBe('control');
    expect(r.control?.intent).toBe('redirect');
  });

  it('glue routes to the fast lane with no bridge', () => {
    const d = routeTurn('thanks');
    expect(d.lane).toBe('fast');
    expect(d.bridge).toBeUndefined();
  });

  it('a project/state question routes to the slow lane with a bridge line', () => {
    const d = routeTurn('how many tests pass');
    expect(d.lane).toBe('slow');
    expect(typeof d.bridge).toBe('string');
    expect(d.bridge!.length).toBeGreaterThan(0);
  });

  it('a stale digest pushes even glue onto the slow lane', () => {
    expect(routeTurn('ok', { digestFresh: true }).lane).toBe('fast');
    expect(routeTurn('ok', { digestFresh: false }).lane).toBe('slow');
  });

  it('bridge line is deterministic per utterance', () => {
    expect(pickBridgeLine('how many tests pass')).toBe(
      pickBridgeLine('how many tests pass'),
    );
  });
});
