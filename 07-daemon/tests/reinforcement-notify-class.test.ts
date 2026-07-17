import { describe, expect, it } from 'vitest';
import { buildReinforcementNotification } from '../src/reinforcement/index.js';

/**
 * DRIVE-QUEUE rider (2026-07-17): turn telemetry is not a
 * notification. The reinforcement loop's routine events (curator
 * inject, wiki hit, raw hit, promotion) filled the bell during live
 * conversation - 3 curator rows in 2 minutes at 03:12-03:14Z while
 * the operator was mid-sentence asking why his bell was full. Those
 * events reclassify as 'conversation' (activity feed only, excluded
 * from the bell by BELL_NOTIFY_CLASSES). The correction demote stays
 * 'signal': the loop acted on user feedback, rare and worth a glance.
 */
describe('reinforcement notification classes: telemetry off the bell', () => {
  const entry = { page: 'some-page', cosine: 0.82 };

  it('curator injection is conversation-class (off the bell)', () => {
    const n = buildReinforcementNotification('injection', entry);
    expect(n?.notify_class).toBe('conversation');
  });

  it('wiki hit is conversation-class', () => {
    const n = buildReinforcementNotification('hit', entry);
    expect(n?.notify_class).toBe('conversation');
  });

  it('raw transcript hit is conversation-class', () => {
    const n = buildReinforcementNotification('raw-hit', entry);
    expect(n?.notify_class).toBe('conversation');
  });

  it('promotion is conversation-class', () => {
    const n = buildReinforcementNotification('promote', entry);
    expect(n?.notify_class).toBe('conversation');
  });

  it('correction demote KEEPS the bell (signal, warn)', () => {
    const n = buildReinforcementNotification('correction', entry);
    expect(n?.notify_class).toBe('signal');
    expect(n?.severity).toBe('warn');
  });

  it('unknown kinds build nothing', () => {
    expect(buildReinforcementNotification('mystery', entry)).toBeNull();
  });
});
