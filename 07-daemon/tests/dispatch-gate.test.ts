/**
 * Dispatch confirm gate (LAYER-1-CONTROL.md Phase B, AUTO-CLEAR T10.2).
 * Pins the context-management carve-out, the parked summary shape, the
 * release / reject once-only semantics, newest-wins per anchor, and the
 * TTL expiry sweep. Pure module, so no mocks: time and ids are injected.
 */
import { describe, expect, it } from 'vitest';
import {
  DispatchGate,
  isContextManagementCaller,
} from '../src/lex/dispatch-gate.js';

const TTL = 10 * 60_000;

/* Deterministic gate: caller advances `clock.t`; ids count up. */
function makeGate(opts: { ttlMs?: number } = {}) {
  const clock = { t: 1_000 };
  let n = 0;
  const gate = new DispatchGate({
    now: () => clock.t,
    id: () => `d${++n}`,
    ttlMs: opts.ttlMs,
  });
  return { gate, clock };
}

describe('isContextManagementCaller', () => {
  it('is true for the context-management labels, by exact match or prefix', () => {
    for (const label of [
      'smart-compact:window-open',
      'smart-clear',
      'smart-clear:plan',
      'event-supervisor',
      'auto-supervisor',
    ]) {
      expect(isContextManagementCaller(label), label).toBe(true);
    }
  });

  it('is false for voice, text, dashboard and empty labels', () => {
    for (const label of ['lex-voice', 'lex-text', 'dashboard:tile', null, undefined, '']) {
      expect(isContextManagementCaller(label), String(label)).toBe(false);
    }
  });

  it('ignores surrounding whitespace but not a different label', () => {
    expect(isContextManagementCaller('  smart-clear  ')).toBe(true);
    expect(isContextManagementCaller('smart-compact')).toBe(false);
    expect(isContextManagementCaller('my-smart-clear')).toBe(false);
  });
});

describe('DispatchGate.park', () => {
  it('collapses body.text to one line, trims it, and caps the summary at 200 chars', () => {
    const { gate } = makeGate();
    const body = {
      target_session: 'cc',
      text: '  run the\n\n  vitest suite\tand report  ',
      caller_label: 'lex-voice',
    };
    const p = gate.park('anchor-a', body);
    expect(p.summary).toBe('run the vitest suite and report');
    expect(p.callerLabel).toBe('lex-voice');
    expect(p.anchorId).toBe('anchor-a');
    expect(p.parkedAtMs).toBe(1_000);
    expect(p.body).toBe(body);

    const long = gate.park('anchor-a', { text: 'x'.repeat(300) });
    expect(long.summary).toHaveLength(200);
    expect(long.summary).toBe('x'.repeat(200));
  });

  it('gives an empty summary and null callerLabel when the body carries neither', () => {
    const { gate } = makeGate();
    const p = gate.park('anchor-a', { target_session: 'cc' });
    expect(p.summary).toBe('');
    expect(p.callerLabel).toBeNull();

    const q = gate.park('anchor-a', { text: 42, caller_label: 7 });
    expect(q.summary).toBe('');
    expect(q.callerLabel).toBeNull();
  });

  it('never overwrites a parked item when the id generator repeats a live id', () => {
    const gate = new DispatchGate({ now: () => 1_000, id: () => 'same' });
    const a = gate.park('anchor-a', { text: 'first' });
    const b = gate.park('anchor-a', { text: 'second' });
    expect(a.id).toBe('same');
    expect(b.id).not.toBe(a.id);
    expect(gate.size()).toBe(2);
    expect(gate.pendingFor('anchor-a')).toBe(b);
    expect(gate.release(a.id)).toBe(a);
    expect(gate.release(b.id)).toBe(b);
  });

  it('defaults to an 8-char id and a 10 minute ttl when not injected', () => {
    let t = 5_000;
    const gate = new DispatchGate({ now: () => t });
    const a = gate.park('anchor-a', { text: 'one' });
    const b = gate.park('anchor-a', { text: 'two' });
    expect(a.id).toMatch(/^[0-9a-f]{8}$/);
    expect(b.id).toMatch(/^[0-9a-f]{8}$/);
    expect(a.id).not.toBe(b.id);

    t = 5_000 + TTL - 1;
    expect(gate.expire(t)).toEqual([]);
    t = 5_000 + TTL;
    expect(gate.expire(t).map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    expect(gate.size()).toBe(0);
  });
});

describe('DispatchGate.pendingFor / release / reject', () => {
  it('returns the parked item for its anchor and releases it exactly once', () => {
    const { gate } = makeGate();
    const p = gate.park('anchor-a', { text: 'run the vitest suite and report' });
    expect(gate.size()).toBe(1);
    expect(gate.pendingFor('anchor-a')).toBe(p);
    expect(gate.pendingFor('anchor-b')).toBeNull();

    const released = gate.release(p.id);
    expect(released).toBe(p);
    expect(released?.body.text).toBe('run the vitest suite and report');
    expect(gate.release(p.id)).toBeNull();
    expect(gate.pendingFor('anchor-a')).toBeNull();
    expect(gate.size()).toBe(0);
  });

  it('returns the newest parked item when one anchor has several', () => {
    const { gate, clock } = makeGate();
    const older = gate.park('anchor-a', { text: 'first' });
    clock.t += 1;
    const newer = gate.park('anchor-a', { text: 'second' });
    expect(gate.pendingFor('anchor-a')).toBe(newer);
    expect(gate.size()).toBe(2);

    gate.release(newer.id);
    expect(gate.pendingFor('anchor-a')).toBe(older);
  });

  it('prefers the later park when two items share a timestamp', () => {
    const { gate } = makeGate();
    gate.park('anchor-a', { text: 'first' });
    const second = gate.park('anchor-a', { text: 'second' });
    expect(gate.pendingFor('anchor-a')).toBe(second);
  });

  it('keeps anchors separate', () => {
    const { gate, clock } = makeGate();
    const a = gate.park('anchor-a', { text: 'for a' });
    clock.t += 1;
    const b = gate.park('anchor-b', { text: 'for b' });
    expect(gate.pendingFor('anchor-a')).toBe(a);
    expect(gate.pendingFor('anchor-b')).toBe(b);
  });

  it('reject removes the item like release and is null the second time', () => {
    const { gate } = makeGate();
    const p = gate.park('anchor-a', { text: 'do the thing' });
    expect(gate.reject(p.id, 'not now')).toBe(p);
    expect(gate.reject(p.id, 'not now')).toBeNull();
    expect(gate.release(p.id)).toBeNull();
    expect(gate.pendingFor('anchor-a')).toBeNull();
    expect(gate.size()).toBe(0);
  });

  it('release and reject return null for an unknown id', () => {
    const { gate } = makeGate();
    expect(gate.release('nope')).toBeNull();
    expect(gate.reject('nope', 'why')).toBeNull();
  });
});

describe('DispatchGate.expire', () => {
  it('removes and returns items at or past the ttl and leaves fresh ones parked', () => {
    const { gate, clock } = makeGate({ ttlMs: TTL });
    const stale = gate.park('anchor-a', { text: 'stale' });
    clock.t += TTL;
    const fresh = gate.park('anchor-b', { text: 'fresh' });

    const expired = gate.expire(clock.t);
    expect(expired).toEqual([stale]);
    expect(gate.size()).toBe(1);
    expect(gate.pendingFor('anchor-a')).toBeNull();
    expect(gate.pendingFor('anchor-b')).toBe(fresh);
    expect(gate.release(stale.id)).toBeNull();
  });

  it('returns nothing and removes nothing before the ttl', () => {
    const { gate, clock } = makeGate({ ttlMs: TTL });
    const p = gate.park('anchor-a', { text: 'x'.repeat(300) });
    expect(gate.expire(clock.t + TTL - 1)).toEqual([]);
    expect(gate.pendingFor('anchor-a')).toBe(p);
    expect(gate.size()).toBe(1);
  });

  it('expires the newest of several for one anchor so pendingFor falls back to none', () => {
    const { gate, clock } = makeGate({ ttlMs: TTL });
    gate.park('anchor-a', { text: 'one' });
    clock.t += 1;
    gate.park('anchor-a', { text: 'two' });
    clock.t += TTL + 1;
    expect(gate.expire(clock.t)).toHaveLength(2);
    expect(gate.pendingFor('anchor-a')).toBeNull();
    expect(gate.size()).toBe(0);
  });
});
