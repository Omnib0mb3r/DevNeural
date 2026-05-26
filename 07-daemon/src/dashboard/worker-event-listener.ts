/**
 * Worker event listener
 * (EVENT-DRIVEN-SUPERVISION.md step 2: chokidar binding that produces
 * WorkerEvent instances from real jsonl deltas).
 *
 * Watches every Claude Code transcript jsonl, maps changed files to
 * project_session anchors, runs the detector pipeline, routes events
 * through routeWorkerEvent + bindKillSwitch + the cross-session
 * inject pipeline. Only fires for anchors with
 * supervision_mode='event'; everything else stays on the legacy
 * polling cron failsafe.
 *
 * processChange is exported so the wiring can be unit-tested without
 * standing up chokidar; the production loop just calls it on each
 * 'add' / 'change' event from the watcher.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type {
  IndexDb,
  ProjectSessionRow,
} from '../store/index-db.js';
import {
  WorkerEventGate,
  getSharedWorkerEventGate,
  resolveLexTargetSession,
  routeWorkerEvent,
  type RouteResult,
  type WorkerEvent,
} from './worker-event-router.js';
import {
  deriveEvents,
  newAnchorTailState,
  parseJsonlTail,
  type AnchorTailState,
} from './worker-event-detect.js';
import { bindKillSwitch } from './worker-event-killswitch.js';
import { recordWorkerEventDiagnostic } from './worker-event-diagnostics.js';
import { ptyInject } from './pty-host.js';
import { defaultGitHelpers, type GitHelpers } from './worker-event-git.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_TAIL_BYTES = 32 * 1024;
const DEFAULT_JSONL_ROOT = path.posix.join(
  os.homedir().replace(/\\/g, '/'),
  '.claude',
  'projects',
);

export interface ListenerDeps {
  db: IndexDb;
  log?: (msg: string) => void;
  /** Override chokidar's watch root. Default ~/.claude/projects. */
  jsonlRoot?: string;
  /** Override the cross-session inject. Tests pass a spy. */
  inject?: (target: string, text: string) => { ok: boolean; reason?: string };
  /** Test seam: per-anchor state map. Defaults to fresh in-memory. */
  state?: Map<string, AnchorTailState>;
  /** Test seam: shared gate. Defaults to fresh WorkerEventGate. */
  gate?: WorkerEventGate;
  /** Override the bound onKillSwitch. Defaults to
   * bindKillSwitch(db). */
  onKillSwitch?: (anchorId: string) => void;
  /** Override resolveLexTargetSession. */
  resolveTarget?: () => string | null;
  /** Tail bytes to read per change. */
  tailBytes?: number;
  /** Fix 34d.2 test seam: git helpers for the narrated-success
   * detector. Production uses cached git rev-parse + log; tests
   * inject a deterministic stub. */
  gitHelpers?: GitHelpers;
}

export interface ProcessChangeResult {
  outcome:
    | 'skipped-no-anchor'
    | 'skipped-mode'
    | 'skipped-no-change'
    | 'no-events'
    | 'routed';
  routed?: RouteResult[];
  anchor_id?: string;
}

/* Fix 34d.1 (2026-05-26): pre-fix shipped routing bug.
 *
 * Earlier code keyed queueSessionPrompt on ref.lex_session_id, which
 * is a brainstorm/lex_session row UUID, NOT a CC session id.
 * writeBridgePrompt creates a `<id>.in` file the 09-bridge VSIX
 * watches; with a non-CC id no daemon-tracked terminal matches and
 * the bridge delivers to whatever VS Code window was in scope =
 * the worker. Net effect: supervisor-event payloads landed in the
 * worker's input field, while the audit row reported decision=
 * 'accepted' delivery_mode='lex-queue'. Operator caught the misroute
 * 2026-05-26 02:30 EDT.
 *
 * Architectural rule (user-stated 2026-05-26 02:35 EDT): daemon NEVER
 * injects directly to worker. Daemon notifies Lex; Lex decides. Only
 * Lex's outputs reach worker.
 *
 * Replacement: deliver via ptyInject keyed on the Lex CC session id.
 * Lex CC runs under a daemon-managed pty so getPtyBySession resolves
 * the handle and the inject lands at Lex's terminal. If the pty
 * handle is missing (Lex CC launched outside daemon spawn), we
 * audit-log the miss and drop — NEVER fall back to a bridge or
 * worker-facing transport. */
export type SupervisorDeliveryMode = 'lex-pty' | 'rejected-not-lex';

export interface DeliverSupervisorPromptResult {
  ok: boolean;
  mode: SupervisorDeliveryMode;
  reason?: string;
}

export function deliverSupervisorPromptToLex(
  db: IndexDb,
  lexCcSessionId: string,
  text: string,
  injectPty: (
    ccSessionId: string,
    text: string,
    commit: boolean,
  ) => { ok: true } | { ok: false; error: string } = ptyInject,
): DeliverSupervisorPromptResult {
  const ref = db.getLexTranscriptRefByCc(lexCcSessionId);
  if (!ref) {
    return {
      ok: false,
      mode: 'lex-pty',
      reason: 'no_lex_transcript_ref',
    };
  }
  /* Inject keyed on the CC session id (NOT lex_session_id). ptyInject
   * resolves by ptyId then by sessionId; cc_session_id matches a
   * daemon-spawned Lex pty's handle.sessionId. The trailing CR commit
   * + bare-CR follow-up nudge are baked into ptyInject already. */
  const r = injectPty(lexCcSessionId, text, true);
  return r.ok
    ? { ok: true, mode: 'lex-pty' }
    : { ok: false, mode: 'lex-pty', reason: r.error };
}

function auditSupervisorRow(
  db: IndexDb,
  target: string,
  text: string,
  mode: SupervisorDeliveryMode,
  ok: boolean,
  reason: string | null,
): void {
  try {
    db.insertCrossSessionLog({
      id: randomUUID(),
      target_session: target,
      caller_label: 'event-supervisor',
      text_preview: text.slice(0, 120),
      text_length: text.length,
      decision: ok ? 'accepted' : 'rejected_pty',
      reject_reason:
        reason !== null
          ? `delivery_mode=${mode} ${reason}`
          : `delivery_mode=${mode}`,
      brainstorm_id: null,
    });
  } catch {
    /* audit best-effort */
  }
}

function buildInject(db: IndexDb): (target: string, text: string) => { ok: boolean; reason?: string } {
  return (target: string, text: string) => {
    recordWorkerEventDiagnostic({
      db,
      stage: 'inject.attempted',
      verdict: null,
      detail: `target=${target.slice(0, 16)} chars=${text.length}`,
    });
    /* Architectural rule (Fix 34d.1, user-stated 2026-05-26 02:35 EDT):
     * daemon NEVER injects directly to worker from the supervisor
     * wire. Daemon notifies Lex; Lex decides. If the resolved target
     * is not a Lex CC, drop with audit — do not fall through to a
     * bridge or worker-facing transport. */
    const isLexTarget = !!db.getLexTranscriptRefByCc(target);
    if (!isLexTarget) {
      auditSupervisorRow(
        db,
        target,
        text,
        'rejected-not-lex',
        false,
        'target_not_lex_cc',
      );
      recordWorkerEventDiagnostic({
        db,
        stage: 'inject.result',
        verdict: 'fail',
        detail: 'mode=rejected-not-lex reason=target_not_lex_cc',
      });
      return { ok: false, reason: 'target_not_lex_cc' };
    }
    try {
      const result = deliverSupervisorPromptToLex(db, target, text);
      auditSupervisorRow(
        db,
        target,
        text,
        result.mode,
        result.ok,
        result.reason ?? null,
      );
      recordWorkerEventDiagnostic({
        db,
        stage: 'inject.result',
        verdict: result.ok ? 'ok' : 'fail',
        detail: result.ok
          ? `mode=${result.mode}`
          : `mode=${result.mode} error=${result.reason ?? ''}`,
      });
      return result.ok
        ? { ok: true }
        : { ok: false, reason: result.reason ?? 'lex-pty-failed' };
    } catch (err) {
      recordWorkerEventDiagnostic({
        db,
        stage: 'inject.result',
        verdict: 'throw',
        detail: `mode=lex-pty ${(err as Error).message}`,
      });
      return { ok: false, reason: (err as Error).message };
    }
  };
}

function readTail(file: string, bytes: number): { text: string; sig: string } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.size === 0) return { text: '', sig: '0:0' };
  const start = Math.max(0, stat.size - bytes);
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return {
      text: buf.toString('utf-8'),
      sig: `${stat.size}:${Math.round(stat.mtimeMs)}`,
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function ccSessionIdFromPath(file: string): string | null {
  const base = path.basename(file);
  if (!base.endsWith('.jsonl')) return null;
  return base.slice(0, -'.jsonl'.length);
}

function resolveAnchorForCc(
  db: IndexDb,
  ccSessionId: string,
): ProjectSessionRow | null {
  const ref = db.getProjectTranscriptRefByCc(ccSessionId);
  if (!ref) return null;
  return db.getProjectSession(ref.anchor_id);
}

export interface ProcessChangeDeps {
  db: IndexDb;
  state: Map<string, AnchorTailState>;
  gate: WorkerEventGate;
  inject: (target: string, text: string) => { ok: boolean; reason?: string };
  onKillSwitch: (anchorId: string) => void;
  /* Optional after Fix 34: when unset, processChange resolves the
   * target via resolveLexTargetSession with the project anchor scoped
   * in. Test code that needs a deterministic spy passes its own
   * function and bypasses the anchor lookup. */
  resolveTarget?: () => string | null;
  tailBytes?: number;
  now?: () => number;
  /** Fix 34d.2: git helpers for the narrated-success detector. */
  gitHelpers?: GitHelpers;
  /** Fix 34d.2 test override: skip the grace window so a contract
   * test can fire the event without sleeping 60 s. */
  successClaimGraceMs?: number;
}

export function processChange(
  file: string,
  deps: ProcessChangeDeps,
): ProcessChangeResult {
  const ccSessionId = ccSessionIdFromPath(file);
  if (!ccSessionId) return { outcome: 'skipped-no-anchor' };
  const anchor = resolveAnchorForCc(deps.db, ccSessionId);
  recordWorkerEventDiagnostic({
    db: deps.db,
    stage: 'chokidar.line',
    anchorId: anchor?.id ?? null,
    verdict: anchor ? 'anchor-resolved' : 'no-anchor',
    detail: `cc=${ccSessionId.slice(0, 8)}`,
  });
  if (!anchor) return { outcome: 'skipped-no-anchor' };
  const effectiveMode =
    anchor.supervision_mode ?? deps.db.getDefaultSupervisionMode();
  if (effectiveMode !== 'event') {
    recordWorkerEventDiagnostic({
      db: deps.db,
      stage: 'gate.evaluated',
      anchorId: anchor.id,
      verdict: 'skipped-mode',
      detail: `mode=${effectiveMode}`,
    });
    return { outcome: 'skipped-mode', anchor_id: anchor.id };
  }
  const tail = readTail(
    file,
    deps.tailBytes ?? DEFAULT_TAIL_BYTES,
  );
  if (!tail) return { outcome: 'skipped-no-change', anchor_id: anchor.id };
  const prev = deps.state.get(anchor.id) ?? newAnchorTailState();
  if (tail.sig && tail.sig === prev.lastTailSig) {
    return { outcome: 'skipped-no-change', anchor_id: anchor.id };
  }
  const now = (deps.now ?? Date.now)();
  const parsed = parseJsonlTail(tail.text);
  /* Fix 34d.2: read git HEAD + recent commits for the anchor's cwd
   * so deriveEvents can run the narrated-success-no-commit detector.
   * Default helpers cache for 5 s; tests inject a deterministic stub. */
  const git = deps.gitHelpers ?? defaultGitHelpers;
  const currentHeadSha = anchor.cwd ? git.getHeadSha(anchor.cwd) : null;
  const recentCommits = anchor.cwd ? git.getRecentCommits(anchor.cwd, 3) : [];
  const { events, nextState } = deriveEvents(
    parsed,
    prev,
    anchor,
    now,
    tail.sig,
    {
      currentHeadSha,
      recentCommits,
      ...(deps.successClaimGraceMs !== undefined
        ? { successClaimGraceMs: deps.successClaimGraceMs }
        : {}),
    },
  );
  deps.state.set(anchor.id, nextState);
  if (events.length === 0) return { outcome: 'no-events', anchor_id: anchor.id };
  for (const ev of events) {
    recordWorkerEventDiagnostic({
      db: deps.db,
      stage: 'detector.matched',
      anchorId: anchor.id,
      verdict: ev.type,
      detail: `worker=${ev.worker_session_id.slice(0, 8)}`,
    });
  }
  const routed: RouteResult[] = [];
  /* Fix 34: anchor-scoped resolver. Pre-fix the listener installed a
   * global default that picked "most recent live lex_session" without
   * checking which project anchor it actually supervised, so the
   * wire silently no-op'd whenever the project's real supervisor was
   * not the most-recently-created lex row. Test code can still
   * inject a deterministic resolveTarget through deps; production
   * leaves it unset and falls through to the anchor-scoped
   * resolveLexTargetSession(..., anchorId) call. */
  const resolveForEvent = deps.resolveTarget ??
    ((): string | null =>
      resolveLexTargetSession(deps.db, { anchorId: anchor.id }));
  for (const ev of events) {
    const result = routeWorkerEvent(ev, {
      gate: deps.gate,
      resolveTarget: resolveForEvent,
      inject: deps.inject,
      anchor,
      onKillSwitch: deps.onKillSwitch,
      now,
      db: deps.db,
    });
    routed.push(result);
  }
  return { outcome: 'routed', routed, anchor_id: anchor.id };
}

export interface WorkerEventListener {
  stop: () => Promise<void>;
  /** Test seam: drive a synthetic change without touching the
   * filesystem watcher. */
  processChange: (file: string) => ProcessChangeResult;
}

export function startWorkerEventListener(
  deps: ListenerDeps,
): WorkerEventListener {
  const root = (deps.jsonlRoot ?? DEFAULT_JSONL_ROOT).replace(/\\/g, '/');
  const log = deps.log ?? (() => undefined);
  const state = deps.state ?? new Map();
  /* Brainstorm-as-durable-primary-entity (2026-05-22, plan section L
   * reconcile). Use the shared module-level gate so the expectation-
   * supervisor's expectation_drift events share the same per-anchor
   * 12/hour cap. Tests still inject their own gate via deps.gate. */
  const gate = deps.gate ?? getSharedWorkerEventGate();
  const inject = deps.inject ?? buildInject(deps.db);
  const onKillSwitch = deps.onKillSwitch ?? bindKillSwitch(deps.db);
  /* Fix 34: do NOT install a global-pick default here. processChange
   * resolves per-anchor via resolveLexTargetSession(db, { anchorId })
   * when no explicit override was supplied. The pre-fix path always
   * threaded a global-pick resolver into procDeps, which silently
   * shadowed the anchor-scoped lookup. */
  const tailBytes = deps.tailBytes;

  const procDeps: ProcessChangeDeps = {
    db: deps.db,
    state,
    gate,
    inject,
    onKillSwitch,
    ...(deps.resolveTarget ? { resolveTarget: deps.resolveTarget } : {}),
    ...(tailBytes !== undefined ? { tailBytes } : {}),
    ...(deps.gitHelpers ? { gitHelpers: deps.gitHelpers } : {}),
  };

  let watcher: FSWatcher | null = null;
  if (fs.existsSync(root)) {
    /* Fix 34b: chokidar v4 removed glob support entirely. The prior
     * form watched the glob string root + slash + double-star + slash
     * + asterisk + .jsonl as a LITERAL file path that did not exist,
     * so the watcher bound (emitting 'ready') but never matched any
     * subsequent jsonl write. Switch to watching the directory and
     * filtering with `ignored` -- the same pattern fs-watcher.ts
     * already uses. Directories are not ignored so chokidar recurses
     * into ~/.claude/projects/<slug>/; non-jsonl files are skipped
     * once stats arrive. ignorePermissionErrors keeps the daemon log
     * clean if any subdir is unreadable. */
    watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
      ignored: (filePath: string, stats?: fs.Stats) => {
        if (stats && stats.isFile()) {
          return !filePath.endsWith('.jsonl');
        }
        return false;
      },
      ignorePermissionErrors: true,
    });
    const handler = (file: string): void => {
      try {
        const r = processChange(file.replace(/\\/g, '/'), procDeps);
        if (r.outcome === 'routed') {
          log(
            `[worker-event] anchor=${r.anchor_id} routed=${r.routed?.length ?? 0}`,
          );
        }
      } catch (err) {
        log(`[worker-event] processChange failed: ${(err as Error).message}`);
      }
    };
    watcher.on('add', handler);
    watcher.on('change', handler);
    watcher.on('error', (err: unknown) => {
      log(`[worker-event] watcher error: ${(err as Error)?.message ?? err}`);
    });
    watcher.on('ready', () => {
      recordWorkerEventDiagnostic({
        db: deps.db,
        stage: 'chokidar.bound',
        verdict: 'ready',
        detail: `root=${root}`,
      });
      log(`[worker-event] chokidar ready at ${root}`);
    });
    log(`[worker-event] watching ${root}`);
  } else {
    recordWorkerEventDiagnostic({
      db: deps.db,
      stage: 'chokidar.bound',
      verdict: 'no-root',
      detail: `root=${root}`,
    });
    log(`[worker-event] jsonl root not present: ${root}; listener idle`);
  }

  return {
    stop: async () => {
      if (watcher) await watcher.close();
    },
    processChange: (file: string) => processChange(file, procDeps),
  };
}

