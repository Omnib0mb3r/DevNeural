import { describe, expect, it } from 'vitest';
import {
  createEndpointState,
  decideEndpoint,
  ENDPOINT_MIN_DELAY_MS,
  ENDPOINT_MAX_HOLD_MS,
} from '../src/voice/engine/endpoint-governor.js';

/**
 * Spec: semantic endpointing via Smart Turn downstream of silero with
 * LiveKit-style bounded dynamic delay (about 0.5s min, 3s max, hard
 * fallback timeout). An "incomplete" prediction extends the wait
 * instead of shipping the fragment; pauses never end the turn, the
 * hard ceiling does.
 */
describe('endpoint-governor: bounded semantic endpointing', () => {
  it('defaults: 500ms floor, 3000ms ceiling', () => {
    expect(ENDPOINT_MIN_DELAY_MS).toBe(500);
    expect(ENDPOINT_MAX_HOLD_MS).toBe(3_000);
  });

  it('a complete verdict inside the floor still holds (no twitchy shipping)', () => {
    const s = createEndpointState(10_000);
    const d = decideEndpoint(s, 'complete', 10_200);
    expect(d.action).toBe('hold');
  });

  it('a complete verdict past the floor ships', () => {
    const s = createEndpointState(10_000);
    const d = decideEndpoint(s, 'complete', 10_700);
    expect(d.action).toBe('ship');
  });

  it('an incomplete verdict extends the wait (mid-thought pause survives)', () => {
    const s = createEndpointState(10_000);
    const d = decideEndpoint(s, 'incomplete', 11_500);
    expect(d.action).toBe('hold');
    expect(d.nextCheckInMs).toBeGreaterThan(0);
  });

  it('the hard ceiling ships even on incomplete (fallback timeout)', () => {
    const s = createEndpointState(10_000);
    const d = decideEndpoint(s, 'incomplete', 13_100);
    expect(d.action).toBe('ship');
  });

  it('an unavailable verdict degrades to the floor (old behavior)', () => {
    const s = createEndpointState(10_000);
    expect(decideEndpoint(s, 'unavailable', 10_300).action).toBe('hold');
    expect(decideEndpoint(s, 'unavailable', 10_600).action).toBe('ship');
  });

  it('hold responses carry a bounded next-check cadence', () => {
    const s = createEndpointState(10_000);
    const d = decideEndpoint(s, 'incomplete', 10_600);
    expect(d.action).toBe('hold');
    expect(d.nextCheckInMs).toBeLessThanOrEqual(500);
    expect(d.nextCheckInMs).toBeGreaterThanOrEqual(100);
  });
});
