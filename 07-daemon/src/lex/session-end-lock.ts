/**
 * Per-session lock for the session-end pipeline (BF-7 step 20).
 *
 * Multiple paths funnel through `runSessionEndPipeline` for the same
 * session_id: voice WS close, Stop button, spoken "end session", PTY
 * exit, plus an admin /brainstorms/:id/redistill in Wave 2. Without
 * a lock, two concurrent paths could partially write wiki_drafts
 * before the transcript flush completes, leaving inconsistent state
 * (drafts that reference a transcript turn that has not been
 * persisted yet). The lock funnels concurrent calls through a single
 * promise so only one path actually runs the pipeline; the others
 * await its result.
 *
 * In-process Map<sessionId, Promise>. The map entry is deleted on
 * settle so a future redistill can run cleanly. Any error thrown by
 * the pipeline rejects the awaiters identically.
 */

const LOCKS = new Map<string, Promise<unknown>>();

export async function withSessionEndLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = LOCKS.get(sessionId);
  if (existing) {
    /* The existing promise is typed as Promise<unknown>. Awaiters
     * receive whatever the first runner returned; the second caller
     * does NOT re-run the pipeline. The cast is safe in practice
     * because every funnel point invokes the same pipeline function
     * with the same input shape. */
    return existing as Promise<T>;
  }
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      LOCKS.delete(sessionId);
    }
  })();
  LOCKS.set(sessionId, promise);
  return promise;
}

/* Test-only helper. Lets the integration suite assert that no lock
 * leaks between tests. Production code should not call this. */
export function _activeLockCount(): number {
  return LOCKS.size;
}
