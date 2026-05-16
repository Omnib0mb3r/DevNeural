/* Terminal mirror auto-scroll state machine. Pins the contracts:
 *   1. Initial state: following=true (viewport pinned to bottom).
 *   2. Scroll up -> following=false; resume timer armed.
 *   3. Resume timer fires -> following=true + scrollToBottom called.
 *   4. Scroll back to bottom before timer fires -> following=true,
 *      timer cancelled (no redundant snap).
 *   5. Multiple scroll-up events refresh the timer (countdown
 *      restarts from the last scroll, not the first).
 *   6. dispose() cancels any pending timer and stops further
 *      transitions.
 *
 * The controller takes a scheduler seam so the test never relies on
 * real setTimeout/clearTimeout. A toy fake controls fire timing
 * explicitly.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createAutoScrollController,
  DEFAULT_RESUME_MS,
} from '../lib/terminal-auto-scroll';

interface PendingTimer {
  fn: () => void;
  ms: number;
}

function makeScheduler() {
  const pending: PendingTimer[] = [];
  return {
    sched: {
      set(fn: () => void, ms: number): unknown {
        const entry: PendingTimer = { fn, ms };
        pending.push(entry);
        return entry;
      },
      clear(handle: unknown): void {
        const idx = pending.indexOf(handle as PendingTimer);
        if (idx >= 0) pending.splice(idx, 1);
      },
    },
    pending,
    fire(): void {
      const entry = pending.shift();
      if (!entry) throw new Error('no pending timer');
      entry.fn();
    },
  };
}

describe('createAutoScrollController', () => {
  it('starts in following=true so the initial mount renders at bottom', () => {
    const scrollToBottom = vi.fn();
    const sched = makeScheduler();
    const c = createAutoScrollController({
      scrollToBottom,
      scheduler: sched.sched,
    });
    expect(c.isFollowing()).toBe(true);
    /* Constructor must not arm a timer; following is the default. */
    expect(sched.pending.length).toBe(0);
    /* And the initial state did not call scrollToBottom yet — that's
     * the caller's responsibility (xterm replay path scrolls once
     * after the initial buffer write). */
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('scroll-up cancels auto-tail and arms the resume timer', () => {
    const scrollToBottom = vi.fn();
    const sched = makeScheduler();
    const c = createAutoScrollController({
      scrollToBottom,
      scheduler: sched.sched,
    });
    c.onScroll(false);
    expect(c.isFollowing()).toBe(false);
    expect(sched.pending.length).toBe(1);
    expect(sched.pending[0]!.ms).toBe(DEFAULT_RESUME_MS);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('resume timer flips following back to true and pulls viewport down', () => {
    const scrollToBottom = vi.fn();
    const sched = makeScheduler();
    const c = createAutoScrollController({
      scrollToBottom,
      scheduler: sched.sched,
    });
    c.onScroll(false);
    sched.fire();
    expect(c.isFollowing()).toBe(true);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('scroll-back-to-bottom before the timer cancels the pending resume', () => {
    const scrollToBottom = vi.fn();
    const sched = makeScheduler();
    const c = createAutoScrollController({
      scrollToBottom,
      scheduler: sched.sched,
    });
    c.onScroll(false);
    expect(sched.pending.length).toBe(1);
    c.onScroll(true); /* user scrolled back to live tail */
    expect(c.isFollowing()).toBe(true);
    expect(sched.pending.length).toBe(0);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('refreshes the timer on every additional scroll-up so the window restarts', () => {
    const scrollToBottom = vi.fn();
    const sched = makeScheduler();
    const c = createAutoScrollController({
      scrollToBottom,
      scheduler: sched.sched,
    });
    c.onScroll(false);
    const firstTimer = sched.pending[0];
    c.onScroll(false);
    const secondTimer = sched.pending[0];
    /* The clear() inside scheduleResume removed the first entry and
     * the next set() appended a fresh one. Identity must differ. */
    expect(secondTimer).not.toBe(firstTimer);
    expect(sched.pending.length).toBe(1);
  });

  it('honours a custom resumeMs', () => {
    const sched = makeScheduler();
    const c = createAutoScrollController({
      scrollToBottom: vi.fn(),
      scheduler: sched.sched,
      resumeMs: 1234,
    });
    c.onScroll(false);
    expect(sched.pending[0]!.ms).toBe(1234);
  });

  it('dispose cancels the pending timer and ignores subsequent events', () => {
    const scrollToBottom = vi.fn();
    const sched = makeScheduler();
    const c = createAutoScrollController({
      scrollToBottom,
      scheduler: sched.sched,
    });
    c.onScroll(false);
    expect(sched.pending.length).toBe(1);
    c.dispose();
    expect(sched.pending.length).toBe(0);
    /* Further events are no-ops; following stays where dispose left it. */
    c.onScroll(false);
    expect(sched.pending.length).toBe(0);
    expect(scrollToBottom).not.toHaveBeenCalled();
  });

  it('survives a scrollToBottom throw inside the resume callback', () => {
    const sched = makeScheduler();
    const c = createAutoScrollController({
      scrollToBottom: () => {
        throw new Error('xterm gone');
      },
      scheduler: sched.sched,
    });
    c.onScroll(false);
    /* Firing must not propagate the throw. */
    expect(() => sched.fire()).not.toThrow();
    /* And following still flips to true so a subsequent write tails. */
    expect(c.isFollowing()).toBe(true);
  });
});
