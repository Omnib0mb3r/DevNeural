import { describe, expect, it } from 'vitest';
import {
  createDeliveryRegistry,
  fingerprintUtterance,
} from '../src/voice/engine/delivery-dedupe.js';

/**
 * Live failure (daemon.log 2026-07-17 03:09:25-41Z): one utterance was
 * delivered to Lex three times - truncated copy (partial landing),
 * verifier full repaste, and a failure-requeue copy at the next turn
 * boundary. The registry is the single gate every re-send path
 * (repaste, flush requeue, CR-commit) must consult: one utterance =
 * one delivery inside the window.
 */
describe('delivery-dedupe: one utterance, one delivery', () => {
  it('first delivery is allowed and recorded', () => {
    const reg = createDeliveryRegistry();
    const fp = fingerprintUtterance('Why is the worker sitting there idle?');
    expect(reg.shouldDeliver(fp, 1_000)).toBe(true);
    reg.markDelivered(fp, 1_000);
    expect(reg.shouldDeliver(fp, 5_000)).toBe(false);
  });

  it('normalization: case, punctuation, and whitespace do not defeat the match', () => {
    const reg = createDeliveryRegistry();
    reg.markDelivered(
      fingerprintUtterance('Why is the worker sitting there idle?'),
      1_000,
    );
    expect(
      reg.shouldDeliver(
        fingerprintUtterance('why is the worker  sitting there idle'),
        2_000,
      ),
    ).toBe(false);
  });

  it('a different utterance is never blocked', () => {
    const reg = createDeliveryRegistry();
    reg.markDelivered(fingerprintUtterance('first thing I said'), 1_000);
    expect(
      reg.shouldDeliver(fingerprintUtterance('second unrelated thing'), 1_500),
    ).toBe(true);
  });

  it('the window expires: a deliberate repeat later goes through', () => {
    const reg = createDeliveryRegistry({ windowMs: 10_000 });
    const fp = fingerprintUtterance('run the tests again');
    reg.markDelivered(fp, 1_000);
    expect(reg.shouldDeliver(fp, 5_000)).toBe(false);
    expect(reg.shouldDeliver(fp, 12_001)).toBe(true);
  });

  it('an explicit force flag bypasses the window (operator repeats on purpose)', () => {
    const reg = createDeliveryRegistry();
    const fp = fingerprintUtterance('run the tests again');
    reg.markDelivered(fp, 1_000);
    expect(reg.shouldDeliver(fp, 2_000, { force: true })).toBe(true);
  });

  it('registry is bounded: old fingerprints fall off at the cap', () => {
    const reg = createDeliveryRegistry({ cap: 2 });
    const a = fingerprintUtterance('utterance a');
    const b = fingerprintUtterance('utterance b');
    const c = fingerprintUtterance('utterance c');
    reg.markDelivered(a, 1_000);
    reg.markDelivered(b, 2_000);
    reg.markDelivered(c, 3_000);
    expect(reg.shouldDeliver(a, 3_500)).toBe(true);
    expect(reg.shouldDeliver(c, 3_500)).toBe(false);
  });
});
