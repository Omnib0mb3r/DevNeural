import { describe, it, expect } from 'vitest';
import { _startVoiceBrainReadyWatch } from '../src/voice/lex-voice-ws.js';

/* Phase 2 R2 / acceptance-3: pressing Start voice starts the top
 * (Lex voice) headless session; the control shows "connecting" until
 * the top session is WARM, then goes live. The daemon drives that
 * transition with a `voice-brain` frame: ready:false while warming,
 * ready:true the moment isVoiceBrainSessionWarm() flips (or a fail-open
 * cap so the operator is never locked in "connecting" if the brain
 * never warms). When the top session is disabled, the gate is a no-op:
 * ready:true immediately, so nothing that works today breaks. */

interface Sent {
  t: string;
  ready?: boolean;
  [k: string]: unknown;
}

function harness(opts: { enabled: boolean; warm: boolean }) {
  let warm = opts.warm;
  let clock = 0;
  const sends: Sent[] = [];
  let next: (() => void) | null = null;
  let cleared = 0;
  const cancel = _startVoiceBrainReadyWatch({
    enabled: opts.enabled,
    isWarm: () => warm,
    send: (m) => sends.push(m as Sent),
    schedule: (fn) => {
      next = fn;
      return 1;
    },
    clearTimer: () => {
      next = null;
      cleared += 1;
    },
    now: () => clock,
    pollMs: 100,
    capMs: 1000,
  });
  return {
    sends,
    cancel,
    setWarm: (v: boolean) => {
      warm = v;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    tick: () => {
      const f = next;
      next = null;
      f?.();
    },
    hasTimer: () => next !== null,
    cleared: () => cleared,
  };
}

describe('_startVoiceBrainReadyWatch (Phase 2 R2 connecting->live gate)', () => {
  it('sends ready:false immediately and schedules a poll while the top brain is cold', () => {
    const h = harness({ enabled: true, warm: false });
    expect(h.sends).toEqual([{ t: 'voice-brain', ready: false }]);
    expect(h.hasTimer()).toBe(true);
  });

  it('sends ready:true and stops polling the moment the brain warms', () => {
    const h = harness({ enabled: true, warm: false });
    h.tick(); // still cold: no new frame, reschedules
    expect(h.sends).toEqual([{ t: 'voice-brain', ready: false }]);
    expect(h.hasTimer()).toBe(true);
    h.setWarm(true);
    h.tick();
    expect(h.sends).toEqual([
      { t: 'voice-brain', ready: false },
      { t: 'voice-brain', ready: true },
    ]);
    expect(h.hasTimer()).toBe(false);
  });

  it('goes live immediately when the brain is already warm at attach', () => {
    const h = harness({ enabled: true, warm: true });
    expect(h.sends).toEqual([{ t: 'voice-brain', ready: true }]);
    expect(h.hasTimer()).toBe(false);
  });

  it('is a no-op gate when the top session is disabled: ready:true, no polling', () => {
    const h = harness({ enabled: false, warm: false });
    expect(h.sends).toEqual([{ t: 'voice-brain', ready: true }]);
    expect(h.hasTimer()).toBe(false);
  });

  it('fails open at the cap so the operator is never stuck connecting', () => {
    const h = harness({ enabled: true, warm: false });
    h.advance(1000); // reach cap while still cold
    h.tick();
    expect(h.sends).toEqual([
      { t: 'voice-brain', ready: false },
      { t: 'voice-brain', ready: true },
    ]);
    expect(h.hasTimer()).toBe(false);
  });

  it('cancel clears any pending poll timer', () => {
    const h = harness({ enabled: true, warm: false });
    expect(h.hasTimer()).toBe(true);
    h.cancel();
    expect(h.hasTimer()).toBe(false);
    expect(h.cleared()).toBeGreaterThanOrEqual(1);
  });
});
