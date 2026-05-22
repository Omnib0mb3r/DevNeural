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
import { crossSessionInject, issueToken } from '../lex/cross-session-inject.js';

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

function buildInject(db: IndexDb): (target: string, text: string) => { ok: boolean; reason?: string } {
  return (target: string, text: string) => {
    try {
      const token = issueToken(target);
      const r = crossSessionInject(
        {
          target_session: target,
          token,
          text,
          caller_label: 'event-supervisor',
          commit: true,
        },
        db,
      );
      return r.ok
        ? { ok: true }
        : { ok: false, reason: r.decision };
    } catch (err) {
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
  resolveTarget: () => string | null;
  tailBytes?: number;
  now?: () => number;
}

export function processChange(
  file: string,
  deps: ProcessChangeDeps,
): ProcessChangeResult {
  const ccSessionId = ccSessionIdFromPath(file);
  if (!ccSessionId) return { outcome: 'skipped-no-anchor' };
  const anchor = resolveAnchorForCc(deps.db, ccSessionId);
  if (!anchor) return { outcome: 'skipped-no-anchor' };
  if ((anchor.supervision_mode ?? deps.db.getDefaultSupervisionMode()) !== 'event') {
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
  const { events, nextState } = deriveEvents(
    parsed,
    prev,
    anchor,
    now,
    tail.sig,
  );
  deps.state.set(anchor.id, nextState);
  if (events.length === 0) return { outcome: 'no-events', anchor_id: anchor.id };
  const routed: RouteResult[] = [];
  for (const ev of events) {
    routed.push(
      routeWorkerEvent(ev, {
        gate: deps.gate,
        resolveTarget: deps.resolveTarget,
        inject: deps.inject,
        anchor,
        onKillSwitch: deps.onKillSwitch,
        now,
      }),
    );
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
  const resolveTarget =
    deps.resolveTarget ?? (() => resolveLexTargetSession(deps.db));
  const tailBytes = deps.tailBytes;

  const procDeps: ProcessChangeDeps = {
    db: deps.db,
    state,
    gate,
    inject,
    onKillSwitch,
    resolveTarget,
    ...(tailBytes !== undefined ? { tailBytes } : {}),
  };

  let watcher: FSWatcher | null = null;
  if (fs.existsSync(root)) {
    watcher = chokidar.watch(`${root}/**/*.jsonl`, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
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
    log(`[worker-event] watching ${root}`);
  } else {
    log(`[worker-event] jsonl root not present: ${root}; listener idle`);
  }

  return {
    stop: async () => {
      if (watcher) await watcher.close();
    },
    processChange: (file: string) => processChange(file, procDeps),
  };
}

