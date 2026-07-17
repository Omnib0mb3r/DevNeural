import { describe, expect, it } from 'vitest';
import {
  createEndpointState,
  decideEndpoint,
  ENDPOINT_MAX_HOLD_MS,
} from '../src/voice/engine/endpoint-governor.js';
import {
  decideCoalesce,
  emptyCoalescerState,
} from '../src/voice/smart-turn.js';

/**
 * Spec gap closed (2026-07-17): decideCoalesce is deliberately pure -
 * no timers - so a held "incomplete" turn only re-evaluated at the
 * NEXT event. An operator who pauses mid-thought and never speaks
 * again starved forever: the held fragment never shipped. The
 * endpoint governor's bounded loop is the fix: while text is held, a
 * timer re-checks on the governor cadence and force-flushes at the
 * hard ceiling. These tests pin the composition the ws timer uses.
 */
describe('held-turn governor flush: the hard ceiling ships, always', () => {
  it('a held turn inside the ceiling keeps holding on cadence', () => {
    const heldSince = 100_000;
    const d = decideEndpoint(
      createEndpointState(heldSince),
      'incomplete',
      heldSince + 1_000,
    );
    expect(d.action).toBe('hold');
    expect(d.nextCheckInMs).toBeGreaterThan(0);
  });

  it('past the ceiling the governor ships even with no next event', () => {
    const heldSince = 100_000;
    const d = decideEndpoint(
      createEndpointState(heldSince),
      'incomplete',
      heldSince + ENDPOINT_MAX_HOLD_MS,
    );
    expect(d.action).toBe('ship');
  });

  it('the coalescer pop (complete + empty text) releases the held words verbatim', () => {
    const t0 = 50_000;
    const afterHold = decideCoalesce(
      emptyCoalescerState(),
      'incomplete',
      'so what I was thinking is',
      t0,
    );
    expect(afterHold.action).toBe('hold');
    const popped = decideCoalesce(
      afterHold.nextState,
      'complete',
      '',
      t0 + ENDPOINT_MAX_HOLD_MS,
    );
    expect(popped.action).toBe('process');
    expect(popped.text).toBe('so what I was thinking is');
    /* State is drained: nothing held afterwards. */
    const again = decideCoalesce(
      popped.nextState,
      'complete',
      '',
      t0 + ENDPOINT_MAX_HOLD_MS + 1_000,
    );
    expect(again.text).toBe('');
  });
});
