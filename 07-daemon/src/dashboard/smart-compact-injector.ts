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
import * as fs from 'node:fs';
import * as path from 'node:path';
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

/* ---------------------------------------------------------------- *
 *   New-session readiness gate for /clear + summary resume paste     *
 * ---------------------------------------------------------------- *
 *
 * Background. Smart compact's 'fire' action injects `/clear` followed
 * by the resume summary. `/clear` causes claude-code to spawn a fresh
 * session (~7s on the host this was tuned for). With the time-based
 * 850ms auto-CR nudge from makeSmartCompactInjector, the summary paste
 * + its CR fired inside the new-session init window: the summary text
 * landed in the input box (visible to the operator), but the CR
 * arrived before CC was accepting commits and got swallowed. Result:
 * the summary sat parked and a manual rescue CR was needed to ship it.
 *
 * Fix. Replace the fixed 850ms wait BETWEEN the /clear inject and the
 * summary inject with an event-driven gate that observes the
 * filesystem signals CC writes when a fresh session is fully attached:
 *
 *   1. Capture pre-clear set of .jsonl filenames in the project's
 *      ~/.claude/projects/<slug>/ directory.
 *   2. Inject /clear.
 *   3. Poll the project dir for a NEW jsonl filename (200ms tick,
 *      15s total budget).
 *   4. Tail the new jsonl for SessionStart attachment entries
 *      (type='attachment' AND attachment.hookEvent starts with
 *      'SessionStart'). The SessionStart hook chain emits a burst of
 *      these within ~50ms; wait `quiescenceMs` after the last one
 *      before declaring readiness so we don't paste summary mid-burst.
 *   5. Inject summary.
 *   6. The existing 850ms CR nudge stays, but now fires while CC is
 *      already accepting commits, so the rescue CR lands.
 *
 * If either step times out the caller is expected to fall back to the
 * legacy back-to-back inject path with a logged warning.
 */

export interface SessionReadyResult {
  ready: boolean;
  reason:
    | 'ready'
    | 'timeout-new-jsonl'
    | 'timeout-session-start'
    | 'no-projects-dir';
  elapsed_ms: number;
  new_jsonl?: string;
}

export interface SessionReadyIO {
  existsSync?: (p: string) => boolean;
  readdirSync?: (dir: string) => string[];
  statSync?: (p: string) => { size: number };
  openSync?: (p: string, flags: string) => number;
  readSync?: (
    fd: number,
    buf: Buffer,
    off: number,
    len: number,
    pos: number,
  ) => number;
  closeSync?: (fd: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface AwaitNewSessionReadyOpts {
  ccProjectsDir: string;
  preClearFiles: ReadonlySet<string>;
  pollIntervalMs?: number;
  readyTimeoutMs?: number;
  quiescenceMs?: number;
  io?: SessionReadyIO;
}

export function capturePreClearJsonlSet(
  ccProjectsDir: string,
  io: SessionReadyIO = {},
): Set<string> {
  const existsSync = io.existsSync ?? fs.existsSync;
  const readdirSync = io.readdirSync ?? ((d: string) => fs.readdirSync(d));
  if (!existsSync(ccProjectsDir)) return new Set();
  try {
    return new Set(readdirSync(ccProjectsDir).filter((n) => n.endsWith('.jsonl')));
  } catch {
    return new Set();
  }
}

/** CC stores per-project session transcripts under
 *  ~/.claude/projects/<slug>/, slug = cwd with [\/\:] replaced by '-'.
 *  Mirrors the slug pattern used in lex-voice-ws.ts so both paths
 *  agree on which directory to watch. */
export function ccProjectsDirForCwd(homeDir: string, cwd: string): string {
  const slug = cwd.replace(/[\\/:]/g, '-');
  return path.posix.join(
    homeDir.replace(/\\/g, '/'),
    '.claude',
    'projects',
    slug,
  );
}

export async function awaitNewSessionReady(
  opts: AwaitNewSessionReadyOpts,
): Promise<SessionReadyResult> {
  const io = opts.io ?? {};
  const now = io.now ?? Date.now;
  const log = io.log ?? (() => undefined);
  const sleep =
    io.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        if (typeof (t as { unref?: () => void }).unref === 'function') {
          (t as { unref: () => void }).unref();
        }
      }));
  const existsSync = io.existsSync ?? fs.existsSync;
  const readdirSync = io.readdirSync ?? ((d: string) => fs.readdirSync(d));
  const statSync =
    io.statSync ??
    ((p: string) => {
      const s = fs.statSync(p);
      return { size: s.size };
    });
  const openSync = io.openSync ?? fs.openSync;
  const readSync = io.readSync ?? fs.readSync;
  const closeSync = io.closeSync ?? fs.closeSync;

  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
  const quiescenceMs = opts.quiescenceMs ?? 400;

  const t0 = now();
  if (!existsSync(opts.ccProjectsDir)) {
    log(
      `smart-compact: session-ready-wait-skip reason=no-projects-dir dir=${opts.ccProjectsDir}`,
    );
    return { ready: false, reason: 'no-projects-dir', elapsed_ms: 0 };
  }

  /* Step A: poll for a NEW jsonl filename (one not in preClearFiles). */
  let newJsonl: string | null = null;
  while (!newJsonl && now() - t0 < readyTimeoutMs) {
    try {
      const names = readdirSync(opts.ccProjectsDir).filter((n) =>
        n.endsWith('.jsonl'),
      );
      for (const name of names) {
        if (!opts.preClearFiles.has(name)) {
          newJsonl = path.posix.join(
            opts.ccProjectsDir.replace(/\\/g, '/'),
            name,
          );
          break;
        }
      }
    } catch {
      /* readdir flake; retry next tick */
    }
    if (!newJsonl) await sleep(pollIntervalMs);
  }
  if (!newJsonl) {
    const elapsed = now() - t0;
    log(
      `smart-compact: session-ready-wait-timeout reason=timeout-new-jsonl elapsed=${elapsed}ms`,
    );
    return { ready: false, reason: 'timeout-new-jsonl', elapsed_ms: elapsed };
  }

  /* Step B: tail the new jsonl for SessionStart attachment entries.
   * Track the most recent attachment ms; when quiescenceMs elapses
   * without a new attachment after at least one was seen, the chain
   * is settled and CC is accepting commits. */
  let lastAttachmentMs = 0;
  let offset = 0;
  while (now() - t0 < readyTimeoutMs) {
    let chunk: string | null = null;
    try {
      const stat = statSync(newJsonl);
      if (stat.size > offset) {
        const len = stat.size - offset;
        const buf = Buffer.alloc(len);
        const fd = openSync(newJsonl, 'r');
        try {
          readSync(fd, buf, 0, len, offset);
        } finally {
          closeSync(fd);
        }
        chunk = buf.toString('utf-8');
        offset = stat.size;
      }
    } catch {
      /* race with writer; retry next tick */
    }
    if (chunk) {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as {
            type?: string;
            attachment?: { hookEvent?: string; hookName?: string };
          };
          const isAttachment = rec.type === 'attachment';
          const hook =
            rec.attachment?.hookEvent ?? rec.attachment?.hookName ?? '';
          if (isAttachment && hook.startsWith('SessionStart')) {
            lastAttachmentMs = now();
          }
        } catch {
          /* malformed line; ignore */
        }
      }
    }
    if (lastAttachmentMs > 0 && now() - lastAttachmentMs >= quiescenceMs) {
      return {
        ready: true,
        reason: 'ready',
        elapsed_ms: now() - t0,
        new_jsonl: newJsonl,
      };
    }
    await sleep(pollIntervalMs);
  }
  const elapsed = now() - t0;
  log(
    `smart-compact: session-ready-wait-timeout reason=timeout-session-start elapsed=${elapsed}ms`,
  );
  return {
    ready: false,
    reason: 'timeout-session-start',
    elapsed_ms: elapsed,
    new_jsonl: newJsonl,
  };
}
