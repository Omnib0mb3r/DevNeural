/**
 * Terminal mirror auto-scroll state machine.
 *
 * Required behaviour:
 *   - Viewport pinned to bottom by default.
 *   - When the user scrolls up, pause auto-tail (new output must NOT
 *     pull the viewport down; the user is reading).
 *   - After RESUME_MS of no further scroll activity, snap back to
 *     bottom and resume tailing.
 *   - If the user scrolls back to bottom on their own, cancel the
 *     pending resume timer (we're already where we want to be).
 *
 * Implementation lives in its own module so the TerminalMirror
 * useEffect only wires xterm events into this controller. The state
 * machine is pure-function modulo the injected scheduler + scroll
 * action, which means tests can exercise every transition without
 * standing up xterm + canvas + webgl.
 */

export interface AutoScrollSchedulerHandle {
  /** Opaque per-timer token returned by set(); pass back to clear(). */
}

export interface AutoScrollScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface AutoScrollControllerOptions {
  /** Resume delay in ms. Spec: 3-5s; default 4000. */
  resumeMs?: number;
  /** Pull the viewport to the bottom. Wired to term.scrollToBottom. */
  scrollToBottom: () => void;
  /** Scheduler injection seam. Defaults to setTimeout / clearTimeout. */
  scheduler?: AutoScrollScheduler;
}

export interface AutoScrollController {
  /** True when new output should auto-pull the viewport down. */
  isFollowing(): boolean;
  /** Call from xterm.onScroll. atBottom tells the controller whether
   * the viewport is at the live tail; it transitions following on/off
   * and schedules / clears the resume timer accordingly. */
  onScroll(atBottom: boolean): void;
  /** Cancel the pending resume timer and reset state. Cleanup on
   * unmount or session swap so we never fire scrollToBottom on a
   * disposed terminal. */
  dispose(): void;
}

export const DEFAULT_RESUME_MS = 4000;

const defaultScheduler: AutoScrollScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createAutoScrollController(
  opts: AutoScrollControllerOptions,
): AutoScrollController {
  const resumeMs = opts.resumeMs ?? DEFAULT_RESUME_MS;
  const sched = opts.scheduler ?? defaultScheduler;
  let following = true;
  let resumeHandle: unknown = null;
  let disposed = false;

  function clearResume(): void {
    if (resumeHandle !== null) {
      sched.clear(resumeHandle);
      resumeHandle = null;
    }
  }

  function scheduleResume(): void {
    clearResume();
    if (disposed) return;
    resumeHandle = sched.set(() => {
      resumeHandle = null;
      if (disposed) return;
      following = true;
      try {
        opts.scrollToBottom();
      } catch {
        /* observational; never throw out of the timer. */
      }
    }, resumeMs);
  }

  return {
    isFollowing(): boolean {
      return following;
    },
    onScroll(atBottom: boolean): void {
      if (disposed) return;
      if (atBottom) {
        /* Either the user scrolled back down or a scrollToBottom we
         * fired settled. Either way: cancel the pending resume and
         * mark following true so the next write tails live. */
        following = true;
        clearResume();
        return;
      }
      /* User is reading older output. Stop following so new writes
       * do not pull the viewport, and arm the resume timer. Each
       * additional scroll event refreshes the timer so the user has
       * the full window after their LAST scroll, not their first. */
      following = false;
      scheduleResume();
    },
    dispose(): void {
      disposed = true;
      clearResume();
    },
  };
}
