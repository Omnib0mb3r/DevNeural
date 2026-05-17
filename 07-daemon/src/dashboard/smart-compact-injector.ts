/**
 * Shared smart-compact PTY injector with bridge fallback.
 *
 * fireSmartCompact and the scheduler tick both need to deliver
 * /clear + resume-summary into a worker anchor's session. The
 * underlying transport differs: anchors bound to a daemon-spawned
 * PTY take the direct ptyInject path; anchors bound to a session
 * launched outside the daemon (VS Code terminal, dashboard
 * "Sessions" button, anything that handshakes through the bridge)
 * fall through to the bridge's queueSessionPrompt path. This is the
 * same shape cross-session-inject already implements; pulling it
 * into a shared module guarantees both fireSmartCompact (called by
 * the REST route) and runSmartCompactTick (called by the daemon's
 * 60s scheduler) resolve targets identically. Without that, the
 * scheduler kept returning pty_not_found on bridge-bound workers
 * even after the route was fixed, so context never auto-compacted
 * on bridge-only sessions.
 *
 * After a successful commit=true inject we also schedule a bare-CR
 * nudge through the SAME transport ~850 ms later. The bridge VSIX
 * delivers text via bracketed paste, which the worker treats as a
 * multi-character paste that does NOT include the trailing CR, so
 * /clear + summary sits in the input box and Enter never fires
 * unless something else pokes it. A second entry carrying just
 * '\r' goes through as a one-character paste and is interpreted
 * as a submit. The daemon-owned PTY path occasionally exhibits the
 * same idle-input symptom, so the nudge fires on both transports.
 * This mirrors crossSessionInject's auto-CR pattern verbatim so
 * REST-fire, scheduler-tick, and cross-session-inject all settle
 * the worker the same way.
 *
 * Pure function over the four pty-host / sessions helpers it depends
 * on so tests can drive every branch with fakes.
 */
import type { PtyInjector } from './smart-compact-routes.js';

export interface PtyListEntry {
  ptyId: string;
  sessionId: string | null;
  exited: boolean;
}

export interface QueueResult {
  ok: boolean;
  error?: string;
}

export interface InjectorDeps {
  listPtys: () => PtyListEntry[];
  ptyInject: (
    ptyId: string,
    text: string,
    commit: boolean,
  ) => { ok: true } | { ok: false; error: string };
  queueSessionPrompt: (sessionId: string, text: string) => QueueResult;
  queueSessionSuggestion: (sessionId: string, text: string) => QueueResult;
  /** Schedule the bare-CR nudge after the primary inject. Default
   * is setTimeout with .unref() so a daemon shutdown is not held
   * open by pending timers. */
  scheduleCommit?: (fn: () => void, delayMs: number) => void;
  /** Delay between primary inject and the bare-CR nudge. The
   * default sits in the middle of the bracketed-paste settle
   * window observed on the bridge VSIX path (~750-1000ms). */
  commitDelayMs?: number;
}

const DEFAULT_COMMIT_DELAY_MS = 850;

function defaultScheduleCommit(fn: () => void, delayMs: number): void {
  const t = setTimeout(fn, delayMs);
  if (typeof (t as { unref?: () => void }).unref === 'function') {
    (t as { unref: () => void }).unref();
  }
}

export function makeSmartCompactInjector(deps: InjectorDeps): PtyInjector {
  const scheduleCommit = deps.scheduleCommit ?? defaultScheduleCommit;
  const commitDelayMs = deps.commitDelayMs ?? DEFAULT_COMMIT_DELAY_MS;
  return (target: string, text: string, commit: boolean) => {
    const ptys = deps.listPtys();
    const live = ptys.find(
      (p) => !p.exited && (p.ptyId === target || p.sessionId === target),
    );
    if (live) {
      const r = deps.ptyInject(live.ptyId, text, commit);
      if (!r.ok) return r;
      /* Auto-CR nudge through the same daemon-owned PTY. commit=false
       * on the nudge so ptyInject does not double-append a second CR
       * onto the already-CR-terminated text. Fire-and-forget; the
       * primary inject already succeeded. */
      if (commit) {
        scheduleCommit(() => {
          try {
            deps.ptyInject(live.ptyId, '\r', false);
          } catch {
            /* nudge is fire-and-forget */
          }
        }, commitDelayMs);
      }
      return { ok: true };
    }
    /* Bridge fallback. queueSessionPrompt needs a session id, so a
     * target that's only a stale pty_id from an exited daemon spawn
     * will fail here; that is the correct outcome because there's no
     * worker to talk to anyway. */
    const r = commit
      ? deps.queueSessionPrompt(target, text)
      : deps.queueSessionSuggestion(target, text);
    if (!r.ok) return { ok: false, error: r.error ?? 'inject failed' };
    /* Auto-CR nudge through the bridge transport. See file header for
     * the bracketed-paste rationale. */
    if (commit) {
      scheduleCommit(() => {
        try {
          deps.queueSessionPrompt(target, '\r');
        } catch {
          /* nudge is fire-and-forget */
        }
      }, commitDelayMs);
    }
    return { ok: true };
  };
}
