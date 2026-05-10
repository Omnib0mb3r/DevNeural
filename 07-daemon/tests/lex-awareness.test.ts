/**
 * Wave 2 day 5 step 24b. L1 awareness broadcaster: idle suppression,
 * meeting-mode disable, recent_context shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emitAwarenessEvent,
  recentContext,
  setAwarenessMode,
  _resetAwareness,
} from '../src/lex/awareness.js';

beforeEach(() => {
  _resetAwareness();
});

afterEach(() => {
  _resetAwareness();
});

describe('awareness broadcaster', () => {
  it('emits + appears in recent_context', () => {
    expect(emitAwarenessEvent({ kind: 'reminder-due', label: 'foo' })).toEqual({ emitted: true });
    const r = recentContext();
    expect(r.events.length).toBe(1);
    expect(r.events[0]?.label).toBe('foo');
    expect(r.budget_remaining_tokens).toBeLessThan(400);
  });

  it('idle-duplicate suppression collapses identical back-to-back events', () => {
    expect(emitAwarenessEvent({ kind: 'audit-finding', label: 'x' }).emitted).toBe(true);
    const dup = emitAwarenessEvent({ kind: 'audit-finding', label: 'x' });
    expect(dup.emitted).toBe(false);
    expect(dup.reason).toBe('idle_duplicate');
  });

  it('meeting mode suppresses every emit except manual', () => {
    setAwarenessMode('notes');
    expect(emitAwarenessEvent({ kind: 'audit-finding', label: 'x' }).emitted).toBe(false);
    expect(emitAwarenessEvent({ kind: 'reminder-due', label: 'y' }).emitted).toBe(false);
    expect(emitAwarenessEvent({ kind: 'manual', label: 'admin trigger' }).emitted).toBe(true);
  });

  it('recent_context strips detail by default and includes it when requested', () => {
    emitAwarenessEvent({ kind: 'capture', label: 'note', detail: { ref: 'r1' } });
    const lite = recentContext({ detail: false });
    expect((lite.events[0] as { detail?: unknown }).detail).toBeUndefined();
    const full = recentContext({ detail: true });
    expect((full.events[0] as { detail?: { ref: string } }).detail?.ref).toBe('r1');
  });
});
