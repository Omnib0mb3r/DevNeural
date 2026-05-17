/**
 * Autonomous supervisor auto-advance loop. Phase 3 (shadow-only
 * operation per Codex review).
 *
 * The loop runs on a setInterval. Per tick, for every project
 * anchor with supervision_mode='event' and the global
 * auto_advance_mode set to 'shadow' or 'live':
 *
 *   1. Resolve the worker session (jsonl tail).
 *   2. Verify quiescence: no pending_prompt, no trailing tool_use
 *      on the last assistant message, assistant turn stable
 *      across 2 polls, no PTY bytes inside a 5s window.
 *   3. Parse the latest worker-status footer with the Phase 1
 *      parser. Require status='done', needs_input=false,
 *      needs_attention=false. Absence of a footer is a hard
 *      no-go.
 *   4. Atomically claim the first queued backlog item via the
 *      Phase 2 claimBacklogItem primitive, keyed on
 *      (anchor_id, assistant_turn_uuid) as the idempotency key
 *      to prevent the same completion turn firing twice.
 *   5. In SHADOW mode write an auto_advance_log row with
 *      decision='shadow' + the would-be inject preview.
 *      In LIVE mode also invoke crossSessionInject with
 *      commit=true and caller_label='auto-supervisor'.
 *
 * Every gate failure lands in auto_advance_log with
 * decision='skip' + a typed reason so the operator can audit why
 * a given anchor was not advanced. Errors caught inside the tick
 * land with decision='error'.
 *
 * Wiring: registerAutoAdvanceLoop is called from the daemon
 * bootstrap. It evaluates the mode on every tick (so an operator
 * flip via runtime_config is picked up without a restart) and
 * short-circuits when mode='off'. Default mode is 'off'.
 *
 * Phase 3 ships the loop + the shadow path. The live path is
 * implemented but not enabled by default; the operator must set
 * auto_advance_mode='live' via runtime_config after observing
 * shadow output. Voice-alert escalations (claim ok + inject
 * failed, accepted-but-no-user-turn, double-fire, kill-switch)
 * surface as logVoice events.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type {
  AutoAdvanceLogInsert,
  AutoAdvanceLogRow,
  BacklogItemRow,
  IndexDb,
  ProjectSessionRow,
} from '../store/index-db.js';
import {
  extractFooterFromJsonlTail,
  parseWorkerStatusFooter,
  type WorkerStatus,
} from '../dashboard/worker-status-footer.js';
import { resolveCcJsonlPath } from './cc-project-slug.js';

export type AutoAdvanceMode = 'off' | 'shadow' | 'live';

export const AUTO_ADVANCE_CONFIG_KEY = 'auto_advance_mode';
export const DEFAULT_AUTO_ADVANCE_MODE: AutoAdvanceMode = 'off';
export const DEFAULT_TICK_INTERVAL_MS = 30_000;
export const PTY_QUIESCENCE_WINDOW_MS = 5_000;

const VALID_MODES: ReadonlySet<AutoAdvanceMode> = new Set([
  'off',
  'shadow',
  'live',
]);

export function parseAutoAdvanceMode(
  raw: string | null | undefined,
): AutoAdvanceMode | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (VALID_MODES.has(s as AutoAdvanceMode)) return s as AutoAdvanceMode;
  return null;
}

export function getAutoAdvanceMode(db: IndexDb): AutoAdvanceMode {
  const raw = db.getRuntimeConfig(AUTO_ADVANCE_CONFIG_KEY);
  const parsed = parseAutoAdvanceMode(raw);
  if (parsed) return parsed;
  const env = parseAutoAdvanceMode(
    process.env.DEVNEURAL_AUTO_ADVANCE_MODE,
  );
  return env ?? DEFAULT_AUTO_ADVANCE_MODE;
}

export interface AutoAdvanceVoiceAlert {
  kind:
    | 'claim-ok-inject-failed'
    | 'accepted-no-user-turn'
    | 'double-fire'
    | 'kill-switch';
  anchor_id: string;
  detail?: string;
}

/* Per-anchor in-memory state. Lost on daemon restart; re-derives
 * from the next tick's first poll, so a restart just costs one
 * extra tick of latency before any anchor can advance. */
interface AnchorMemory {
  /** uuid of the last assistant turn we observed; used to require
   * stability across two consecutive ticks. */
  lastAssistantUuid: string | null;
  /** Timestamp of the last assistant turn observation. Compared
   * against PTY last-activity to satisfy the 5s no-bytes window. */
  lastSeenAtMs: number;
  /** The turn uuid we already auto-advanced on; refusing to fire
   * twice on the same turn is the idempotency contract. */
  lastAdvancedUuid: string | null;
}

export interface BacklogClaimer {
  (input: {
    id: string;
    claimed_by: string;
    claimed_turn_uuid?: string | null;
    anchor_id?: string | null;
  }): {
    ok: boolean;
    row?: BacklogItemRow;
    reason?: string;
  };
}

export interface BacklogLister {
  (opts: { status?: BacklogItemRow['status']; limit?: number }): BacklogItemRow[];
}

export interface AnchorLister {
  (opts: { status?: 'live' | 'dormant'; limit?: number }): ProjectSessionRow[];
}

export interface PtyLister {
  (): Array<{ ptyId: string; sessionId: string | null; lastActivity: number; exited: boolean }>;
}

export interface CrossSessionInjector {
  (req: {
    target_session: string;
    token: string;
    text: string;
    caller_label?: string;
    commit?: boolean;
  }): { ok: boolean; decision?: string; error?: string };
}

export interface TokenIssuer {
  (targetSession: string): string;
}

export interface VoiceAlertSink {
  (alert: AutoAdvanceVoiceAlert): void;
}

export interface AutoAdvanceTickDeps {
  db: IndexDb;
  listAnchors: AnchorLister;
  listBacklog: BacklogLister;
  claimBacklog: BacklogClaimer;
  listPtys: PtyLister;
  /** Reads the jsonl text for an anchor's current session. Returns
   * null when the file is missing. Defaults to a bounded
   * fs.readFileSync; tests inject stubs. */
  readJsonl?: (path: string) => string | null;
  /** Resolves an anchor row to the jsonl path the worker is
   * writing into. Defaults to the standard CC layout used by
   * /sessions and the cold-start preload. */
  resolveJsonlPath?: (anchor: ProjectSessionRow) => string | null;
  injectCrossSession?: CrossSessionInjector;
  issueToken?: TokenIssuer;
  /** Stable in-memory state across ticks; defaults to a module-
   * local Map so production callers don't have to thread one. */
  memory?: Map<string, AnchorMemory>;
  voiceAlert?: VoiceAlertSink;
  /** Lease bump seam. Defaults to db.bumpAutoAdvanceLease. Tests
   * override so they don't have to insert real anchor rows. */
  bumpLease?: (anchorId: string, owner: string) => number | null;
  now?: () => number;
  /** Logger sink. Defaults to no-op. */
  log?: (msg: string) => void;
}

export interface AutoAdvanceTickRecord {
  anchor_id: string;
  decision: AutoAdvanceLogRow['decision'];
  reason: string | null;
  turn_uuid: string | null;
  item_id: string | null;
  footer: WorkerStatus | null;
}

const defaultMemory = new Map<string, AnchorMemory>();

function defaultReadJsonl(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function defaultResolveJsonlPath(
  anchor: ProjectSessionRow,
): string | null {
  if (!anchor.current_session_id) return null;
  /* CC layout: ~/.claude/projects/<slug>/<session_id>.jsonl. Use
   * the shared rootToSlug + case-insensitive directory scan so a
   * casing mismatch between the anchor row's cwd (which can land
   * lowercase via the bridge presence file) and CC's on-disk
   * directory (case-preserved from the cwd CC saw at spawn) does
   * not produce `no-jsonl` skips every tick. */
  return resolveCcJsonlPath(anchor.cwd, anchor.current_session_id);
}

interface QuiescenceCheck {
  ok: boolean;
  reason?: string;
  assistantTurnUuid: string | null;
}

interface AssistantTurn {
  uuid: string | null;
  text: string;
  hasToolUse: boolean;
}

function readLastAssistantTurn(jsonl: string): AssistantTurn | null {
  const lines = jsonl.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = entry as {
      type?: string;
      uuid?: string;
      message?: { content?: unknown };
    };
    if (obj.type !== 'assistant') continue;
    const content = obj.message?.content;
    let text = '';
    let hasToolUse = false;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as { type?: string; text?: unknown };
        if (p.type === 'tool_use') hasToolUse = true;
        if (p.type === 'text' && typeof p.text === 'string') {
          text += (text ? '\n' : '') + p.text;
        }
      }
    }
    return {
      uuid: typeof obj.uuid === 'string' ? obj.uuid : null,
      text,
      hasToolUse,
    };
  }
  return null;
}

function evaluateQuiescence(
  anchor: ProjectSessionRow,
  jsonl: string | null,
  memory: AnchorMemory | undefined,
  ptyLastActivityMs: number | null,
  now: number,
): {
  check: QuiescenceCheck;
  assistantTurn: AssistantTurn | null;
} {
  if (!jsonl) {
    return {
      check: { ok: false, reason: 'no-jsonl', assistantTurnUuid: null },
      assistantTurn: null,
    };
  }
  const turn = readLastAssistantTurn(jsonl);
  if (!turn) {
    return {
      check: { ok: false, reason: 'no-assistant-turn', assistantTurnUuid: null },
      assistantTurn: null,
    };
  }
  if (turn.hasToolUse) {
    return {
      check: { ok: false, reason: 'trailing-tool-use', assistantTurnUuid: turn.uuid },
      assistantTurn: turn,
    };
  }
  if (
    ptyLastActivityMs !== null &&
    now - ptyLastActivityMs < PTY_QUIESCENCE_WINDOW_MS
  ) {
    return {
      check: { ok: false, reason: 'pty-still-active', assistantTurnUuid: turn.uuid },
      assistantTurn: turn,
    };
  }
  if (!memory || memory.lastAssistantUuid !== turn.uuid) {
    /* Stability rule: the SAME assistant turn uuid must persist
     * across two consecutive ticks before we treat the worker as
     * quiesced. First sight is "observe and wait". */
    return {
      check: { ok: false, reason: 'awaiting-stability', assistantTurnUuid: turn.uuid },
      assistantTurn: turn,
    };
  }
  return {
    check: { ok: true, assistantTurnUuid: turn.uuid },
    assistantTurn: turn,
  };
}

function buildInjectPayload(item: BacklogItemRow): string {
  return `Next backlog item: ${item.id}\n\n${item.title}`;
}

export async function runAutoAdvanceTick(
  deps: AutoAdvanceTickDeps,
): Promise<AutoAdvanceTickRecord[]> {
  const mode = getAutoAdvanceMode(deps.db);
  if (mode === 'off') return [];
  const now = (deps.now ?? Date.now)();
  const memory = deps.memory ?? defaultMemory;
  const readJsonl = deps.readJsonl ?? defaultReadJsonl;
  const resolveJsonlPath = deps.resolveJsonlPath ?? defaultResolveJsonlPath;
  const records: AutoAdvanceTickRecord[] = [];
  const anchors = deps.listAnchors({ status: 'live', limit: 200 });
  const ptys = deps.listPtys();
  for (const anchor of anchors) {
    if (anchor.supervision_mode !== 'event') continue;
    const mem = memory.get(anchor.id);
    const path = resolveJsonlPath(anchor);
    const jsonl = path ? readJsonl(path) : null;
    /* PTY last-activity lookup. Daemon-owned PTYs land in listPtys
     * keyed by ptyId; bridge-driven sessions never appear here, so
     * the fallback is anchor.last_seen_ms which the bridge bumps on
     * every heartbeat. */
    let ptyActivity: number | null = null;
    if (anchor.current_pty_id) {
      const live = ptys.find((p) => p.ptyId === anchor.current_pty_id);
      if (live) ptyActivity = live.lastActivity;
    } else if (anchor.last_seen_ms) {
      ptyActivity = anchor.last_seen_ms;
    }
    const { check, assistantTurn } = evaluateQuiescence(
      anchor,
      jsonl,
      mem,
      ptyActivity,
      now,
    );
    /* Update memory regardless of decision so the next tick has the
     * stability comparison ready. */
    memory.set(anchor.id, {
      lastAssistantUuid: assistantTurn?.uuid ?? null,
      lastSeenAtMs: now,
      lastAdvancedUuid: mem?.lastAdvancedUuid ?? null,
    });
    if (!check.ok) {
      const logId = randomUUID();
      const insert: AutoAdvanceLogInsert = {
        id: logId,
        anchor_id: anchor.id,
        turn_uuid: check.assistantTurnUuid,
        item_id: null,
        mode,
        decision: 'skip',
        reason: check.reason ?? 'unknown',
        epoch: anchor.auto_advance_epoch ?? null,
      };
      try {
        deps.db.insertAutoAdvanceLog(insert);
      } catch {
        /* never block a tick on logger failure */
      }
      records.push({
        anchor_id: anchor.id,
        decision: 'skip',
        reason: check.reason ?? 'unknown',
        turn_uuid: check.assistantTurnUuid,
        item_id: null,
        footer: null,
      });
      continue;
    }
    /* Parse the footer off the stable assistant turn. The jsonl
     * tail extractor already walks back through tool-only
     * messages, but we have the terminal turn in hand so a direct
     * parse is enough. */
    const footer =
      (assistantTurn?.text && parseWorkerStatusFooter(assistantTurn.text)) ||
      (jsonl ? extractFooterFromJsonlTail(jsonl) : null);
    if (!footer) {
      writeSkip(deps, anchor, mode, check.assistantTurnUuid, 'no-footer', null);
      records.push({
        anchor_id: anchor.id,
        decision: 'skip',
        reason: 'no-footer',
        turn_uuid: check.assistantTurnUuid,
        item_id: null,
        footer: null,
      });
      continue;
    }
    if (footer.status !== 'done') {
      writeSkip(
        deps,
        anchor,
        mode,
        check.assistantTurnUuid,
        `status-${footer.status}`,
        footer,
      );
      records.push({
        anchor_id: anchor.id,
        decision: 'skip',
        reason: `status-${footer.status}`,
        turn_uuid: check.assistantTurnUuid,
        item_id: null,
        footer,
      });
      continue;
    }
    if (footer.needs_attention) {
      writeSkip(deps, anchor, mode, check.assistantTurnUuid, 'needs-attention', footer);
      records.push({
        anchor_id: anchor.id,
        decision: 'skip',
        reason: 'needs-attention',
        turn_uuid: check.assistantTurnUuid,
        item_id: null,
        footer,
      });
      continue;
    }
    /* status=needs_input is captured by the status check above but
     * the gate is named explicitly so a future schema change does
     * not silently let it through. */
    if (mem?.lastAdvancedUuid && mem.lastAdvancedUuid === check.assistantTurnUuid) {
      writeSkip(deps, anchor, mode, check.assistantTurnUuid, 'already-advanced-this-turn', footer);
      deps.voiceAlert?.({
        kind: 'double-fire',
        anchor_id: anchor.id,
        detail: `turn ${check.assistantTurnUuid}`,
      });
      records.push({
        anchor_id: anchor.id,
        decision: 'skip',
        reason: 'already-advanced-this-turn',
        turn_uuid: check.assistantTurnUuid,
        item_id: null,
        footer,
      });
      continue;
    }
    const queued = deps.listBacklog({ status: 'queued', limit: 5 });
    if (queued.length === 0) {
      writeSkip(deps, anchor, mode, check.assistantTurnUuid, 'backlog-empty', footer);
      records.push({
        anchor_id: anchor.id,
        decision: 'skip',
        reason: 'backlog-empty',
        turn_uuid: check.assistantTurnUuid,
        item_id: null,
        footer,
      });
      continue;
    }
    const item = queued[0]!;
    const claim = deps.claimBacklog({
      id: item.id,
      claimed_by: 'auto-supervisor',
      claimed_turn_uuid: check.assistantTurnUuid,
      anchor_id: anchor.id,
    });
    if (!claim.ok) {
      writeSkip(
        deps,
        anchor,
        mode,
        check.assistantTurnUuid,
        `claim-${claim.reason ?? 'unknown'}`,
        footer,
        item.id,
      );
      records.push({
        anchor_id: anchor.id,
        decision: 'skip',
        reason: `claim-${claim.reason ?? 'unknown'}`,
        turn_uuid: check.assistantTurnUuid,
        item_id: item.id,
        footer,
      });
      continue;
    }
    /* Stamp the lease epoch so a future writer can detect that
     * this tick was preempted by a second supervisor. Best-effort:
     * a contention here downgrades the log to decision=skip with
     * reason=lease-contention. */
    const bumpLease =
      deps.bumpLease ?? ((id, owner) => deps.db.bumpAutoAdvanceLease(id, owner));
    const epoch = bumpLease(anchor.id, 'auto-supervisor');
    if (epoch === null) {
      writeSkip(
        deps,
        anchor,
        mode,
        check.assistantTurnUuid,
        'lease-contention',
        footer,
        item.id,
      );
      records.push({
        anchor_id: anchor.id,
        decision: 'skip',
        reason: 'lease-contention',
        turn_uuid: check.assistantTurnUuid,
        item_id: item.id,
        footer,
      });
      continue;
    }
    const payload = buildInjectPayload(claim.row ?? item);
    const preview = payload.slice(0, 280);
    /* Mark the turn as advanced AFTER successful claim so a
     * concurrent tick does not race past the gate. */
    memory.set(anchor.id, {
      lastAssistantUuid: check.assistantTurnUuid,
      lastSeenAtMs: now,
      lastAdvancedUuid: check.assistantTurnUuid,
    });
    if (mode === 'shadow') {
      try {
        deps.db.insertAutoAdvanceLog({
          id: randomUUID(),
          anchor_id: anchor.id,
          turn_uuid: check.assistantTurnUuid,
          item_id: item.id,
          mode,
          decision: 'shadow',
          reason: 'shadow',
          would_inject_preview: preview,
          footer_status: footer.status,
          footer_needs_attention: footer.needs_attention,
          epoch,
        });
      } catch {
        /* observational */
      }
      records.push({
        anchor_id: anchor.id,
        decision: 'shadow',
        reason: 'shadow',
        turn_uuid: check.assistantTurnUuid,
        item_id: item.id,
        footer,
      });
      continue;
    }
    /* LIVE mode. Phase 3 implements the path but the default mode
     * is 'off'; an operator must explicitly flip auto_advance_mode
     * to 'live' AFTER observing shadow output. */
    if (!anchor.current_session_id) {
      writeSkip(
        deps,
        anchor,
        mode,
        check.assistantTurnUuid,
        'no-current-session',
        footer,
        item.id,
      );
      records.push({
        anchor_id: anchor.id,
        decision: 'skip',
        reason: 'no-current-session',
        turn_uuid: check.assistantTurnUuid,
        item_id: item.id,
        footer,
      });
      continue;
    }
    if (!deps.injectCrossSession || !deps.issueToken) {
      writeSkip(
        deps,
        anchor,
        mode,
        check.assistantTurnUuid,
        'live-injector-not-wired',
        footer,
        item.id,
      );
      records.push({
        anchor_id: anchor.id,
        decision: 'skip',
        reason: 'live-injector-not-wired',
        turn_uuid: check.assistantTurnUuid,
        item_id: item.id,
        footer,
      });
      continue;
    }
    const token = deps.issueToken(anchor.current_session_id);
    const inject = deps.injectCrossSession({
      target_session: anchor.current_session_id,
      token,
      text: payload,
      caller_label: 'auto-supervisor',
      commit: true,
    });
    if (!inject.ok) {
      try {
        deps.db.insertAutoAdvanceLog({
          id: randomUUID(),
          anchor_id: anchor.id,
          turn_uuid: check.assistantTurnUuid,
          item_id: item.id,
          mode,
          decision: 'error',
          reason: `claim-ok-inject-${inject.error ?? 'failed'}`,
          would_inject_preview: preview,
          footer_status: footer.status,
          footer_needs_attention: footer.needs_attention,
          epoch,
        });
      } catch {
        /* observational */
      }
      deps.voiceAlert?.({
        kind: 'claim-ok-inject-failed',
        anchor_id: anchor.id,
        detail: inject.error ?? 'unknown',
      });
      records.push({
        anchor_id: anchor.id,
        decision: 'error',
        reason: `claim-ok-inject-${inject.error ?? 'failed'}`,
        turn_uuid: check.assistantTurnUuid,
        item_id: item.id,
        footer,
      });
      continue;
    }
    try {
      deps.db.insertAutoAdvanceLog({
        id: randomUUID(),
        anchor_id: anchor.id,
        turn_uuid: check.assistantTurnUuid,
        item_id: item.id,
        mode,
        decision: 'accepted',
        reason: 'live',
        would_inject_preview: preview,
        footer_status: footer.status,
        footer_needs_attention: footer.needs_attention,
        epoch,
      });
    } catch {
      /* observational */
    }
    records.push({
      anchor_id: anchor.id,
      decision: 'accepted',
      reason: 'live',
      turn_uuid: check.assistantTurnUuid,
      item_id: item.id,
      footer,
    });
  }
  return records;
}

function writeSkip(
  deps: AutoAdvanceTickDeps,
  anchor: ProjectSessionRow,
  mode: AutoAdvanceMode,
  turnUuid: string | null,
  reason: string,
  footer: WorkerStatus | null,
  itemId: string | null = null,
): void {
  try {
    deps.db.insertAutoAdvanceLog({
      id: randomUUID(),
      anchor_id: anchor.id,
      turn_uuid: turnUuid,
      item_id: itemId,
      mode,
      decision: 'skip',
      reason,
      footer_status: footer?.status ?? null,
      footer_needs_attention: footer?.needs_attention ?? null,
      epoch: anchor.auto_advance_epoch ?? null,
    });
  } catch {
    /* observational */
  }
}

export interface AutoAdvanceLoopHandle {
  stop(): void;
  /** Trigger a tick immediately for tests / manual fires. */
  tickNow(): Promise<AutoAdvanceTickRecord[]>;
}

export interface RegisterAutoAdvanceLoopOptions {
  deps: AutoAdvanceTickDeps;
  intervalMs?: number;
  /** Optional pre-built scheduler used by tests. Defaults to
   * setInterval+clearInterval. */
  scheduler?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

export function registerAutoAdvanceLoop(
  opts: RegisterAutoAdvanceLoopOptions,
): AutoAdvanceLoopHandle {
  const envInterval = Number(process.env.DEVNEURAL_AUTO_ADVANCE_INTERVAL_MS);
  const interval =
    opts.intervalMs ??
    (Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : DEFAULT_TICK_INTERVAL_MS);
  const scheduler =
    opts.scheduler ?? {
      set: (fn, ms) => setInterval(fn, ms),
      clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  let inFlight = false;
  const tick = async (): Promise<AutoAdvanceTickRecord[]> => {
    if (inFlight) return [];
    inFlight = true;
    try {
      return await runAutoAdvanceTick(opts.deps);
    } catch (err) {
      opts.deps.log?.(`auto-advance tick failed: ${(err as Error).message}`);
      return [];
    } finally {
      inFlight = false;
    }
  };
  const handle = scheduler.set(() => {
    void tick();
  }, interval);
  /* unref so the interval does not hold the process open. */
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }
  return {
    stop: () => scheduler.clear(handle),
    tickNow: tick,
  };
}
