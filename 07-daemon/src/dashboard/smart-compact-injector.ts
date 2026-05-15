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
}

export function makeSmartCompactInjector(deps: InjectorDeps): PtyInjector {
  return (target: string, text: string, commit: boolean) => {
    const ptys = deps.listPtys();
    const live = ptys.find(
      (p) => !p.exited && (p.ptyId === target || p.sessionId === target),
    );
    if (live) return deps.ptyInject(live.ptyId, text, commit);
    /* Bridge fallback. queueSessionPrompt needs a session id, so a
     * target that's only a stale pty_id from an exited daemon spawn
     * will fail here; that is the correct outcome because there's no
     * worker to talk to anyway. */
    const r = commit
      ? deps.queueSessionPrompt(target, text)
      : deps.queueSessionSuggestion(target, text);
    if (r.ok) return { ok: true };
    return { ok: false, error: r.error ?? 'inject failed' };
  };
}
