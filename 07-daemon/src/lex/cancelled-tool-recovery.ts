/**
 * Cancelled-tool recovery (Fix 33).
 *
 * Daemon-side recovery primitive that auto-resumes Lex after any
 * cancelled tool call. Removes the "Lex stuck until the user types
 * again" failure mode regardless of what caused the cancellation
 * (user text preempting tool, hook denial, network hiccup, etc).
 *
 * Why a recovery layer beats trigger-removal: cancellation has many
 * causes; a queue-only fix covers one. Watching the failure pattern
 * itself covers all of them, including ones not enumerated today.
 *
 * Why a daemon-fired continuation is safe: the reject envelope has
 * already ENDED the turn. Lex is no longer mid-turn at reject. The
 * recovery inject is a fresh user turn, not a preempt.
 *
 * Detection: tail every active brainstorm's CC jsonl on a 5 s
 * cadence. When a `user` line carries a `tool_result` whose text
 * matches the canonical CC reject strings (BF-7 of LEX-AUTONOMY), the
 * session is "armed". If no follow-up assistant message arrives
 * within 5 s, fire a single recovery inject via crossSessionInject
 * and disarm. If the recovery itself is cancelled within 30 s of
 * firing, escalate to `recovery_exhausted` (audit row + WS frame to
 * the active voice client). No second auto-fire; surface to the user
 * via dashboard banner.
 *
 * Lifecycle: setInterval ticker started from daemon bootstrap. Stop
 * is wired into the shutdown hook so timers do not keep the process
 * alive on a graceful exit.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IndexDb, BrainstormSessionRow } from '../store/index-db.js';
import {
  crossSessionInject,
  issueToken,
  type InjectResult,
} from './cross-session-inject.js';
import { randomUUID } from 'node:crypto';

/* Canonical CC strings on the reject envelope. Both surfaces are
 * possible: the explicit "user said no" rejection and the broader
 * "request interrupted" rollback (network drop, hook denial, etc).
 * Matched case-insensitively because CC has not been consistent
 * about casing across versions. */
export const REJECT_PATTERNS: RegExp[] = [
  /The user doesn't want to proceed with this tool use/i,
  /Request interrupted by user/i,
];

interface JsonlEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?:
      | string
      | Array<{
          type?: string;
          text?: string;
          content?: unknown;
          is_error?: boolean;
        }>;
  };
  isCompactSummary?: boolean;
  isMeta?: boolean;
}

/* Per-cc-session recovery state. Keyed by cc_session_id. */
export interface CancelledToolRecoveryState {
  brainstorm_id: string;
  cc_session_id: string;
  /** When the most recent reject envelope landed. null = not armed. */
  armedAt: number | null;
  /** Uuid of the user line carrying the reject envelope. Used for
   * structured logging only; clearance is "any new assistant line"
   * because the assistant follow-up's parent chain is the proof. */
  armedTurnUuid: string | null;
  /** Last time a recovery inject was fired for this session. Used
   * by the two-strike escalation: a fresh reject within 30 s of this
   * timestamp = recovery_exhausted instead of another auto-fire. */
  lastRecoveryAt: number | null;
}

/* Internal: composite (brainstorm_id, cc_session_id) jsonl offset
 * map. Same shape as brainstorm-jsonl-ingestor so a repoint creates a
 * fresh key starting at offset 0 instead of reading the new jsonl
 * from the old tail position. */
const offsets = new Map<string, number>();
const stateMap = new Map<string, CancelledToolRecoveryState>();

function offsetKey(brainstormId: string, ccSessionId: string): string {
  return `${brainstormId}:${ccSessionId}`;
}

export function _resetCancelledToolRecoveryForTests(): void {
  offsets.clear();
  stateMap.clear();
}

export function _peekCancelledToolRecoveryState(): Map<
  string,
  CancelledToolRecoveryState
> {
  return new Map(stateMap);
}

/* Mirror defaultResolveJsonlPath from brainstorm-jsonl-ingestor.ts:
 * scan ~/.claude/projects for a per-slug dir that contains the cc
 * session's jsonl file. Kept local rather than imported to avoid
 * coupling the two background services. */
function defaultResolveJsonlPath(
  row: BrainstormSessionRow,
): string | null {
  if (!row.claude_session_id) return null;
  const root = path.posix.join(
    os.homedir().replace(/\\/g, '/'),
    '.claude',
    'projects',
  );
  if (!fs.existsSync(root)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.posix.join(
      root,
      e.name,
      `${row.claude_session_id}.jsonl`,
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function defaultReadSince(
  file: string,
  offset: number,
): { text: string; newOffset: number } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.size <= offset) {
    return { text: '', newOffset: offset };
  }
  const cap = 4 * 1024 * 1024;
  const end = Math.min(stat.size, offset + cap);
  const length = end - offset;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }
  return { text: buf.toString('utf-8'), newOffset: end };
}

/* Pull every textual surface out of a user message's tool_result
 * parts and concatenate. CC has historically used either a flat
 * string `content` or an array of `{type, text}` parts; cover both
 * so a future format tweak does not silently break detection. */
export function extractToolResultText(entry: JsonlEntry): string {
  const c = entry.message?.content;
  if (!Array.isArray(c)) return '';
  let out = '';
  for (const part of c) {
    if (!part || part.type !== 'tool_result') continue;
    const innerText = part.text;
    if (typeof innerText === 'string') {
      out += (out ? '\n' : '') + innerText;
    }
    const innerContent = part.content;
    if (typeof innerContent === 'string') {
      out += (out ? '\n' : '') + innerContent;
    } else if (Array.isArray(innerContent)) {
      for (const inner of innerContent) {
        const t = (inner as { text?: string }).text;
        if (typeof t === 'string') out += (out ? '\n' : '') + t;
      }
    }
  }
  return out;
}

export function isRejectEnvelope(text: string): boolean {
  return REJECT_PATTERNS.some((re) => re.test(text));
}

/* Recovery inject body. Imperative phrasing per spec: Lex should
 * resume on best judgment without asking the user to confirm. The
 * body explicitly frames the cancellation as a transient
 * interruption so Lex does not treat it as a deliberate reject. */
export const RECOVERY_INJECT_BODY =
  '[recovery] A tool call was cancelled. Treat as transient interruption, not a deliberate reject. Resume where you left off: re-emit the cancelled call OR continue with the next step. Act on best judgment, do not ask user to confirm.';

export interface CancelledToolRecoveryDeps {
  db: IndexDb;
  listActiveBrainstorms?: () => BrainstormSessionRow[];
  resolveJsonlPath?: (row: BrainstormSessionRow) => string | null;
  readSince?: (
    file: string,
    offset: number,
  ) => { text: string; newOffset: number } | null;
  /** Defaults to crossSessionInject; tests stub. */
  crossSessionInject?: (
    target_session: string,
    text: string,
    callerLabel: string,
  ) => InjectResult;
  /** Notify the active voice client of an exhaustion. Defaults to a
   * no-op so tests do not need to stand up a WS registry. Production
   * wires this to a per-bindKey WS broadcast in daemon.ts. */
  notifyExhausted?: (ccSessionId: string, reason: string) => void;
  /** Time source; tests pump this forward via fake timers. */
  now?: () => number;
  log?: (msg: string) => void;
}

export interface StartCancelledToolRecoveryOptions {
  deps: CancelledToolRecoveryDeps;
  /** Tick cadence. Default 5000 ms. */
  intervalMs?: number;
  /** How long to wait after a cancellation before firing recovery.
   * Default 5000 ms. */
  recoveryDelayMs?: number;
  /** Strike window: a second cancellation arriving within this many
   * ms after lastRecoveryAt escalates to recovery_exhausted instead
   * of firing another auto-recovery. Default 30000 ms. */
  exhaustWindowMs?: number;
  scheduler?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

export interface CancelledToolRecoveryHandle {
  stop(): void;
  tickNow(): void;
}

export const DEFAULT_RECOVERY_INTERVAL_MS = 5_000;
export const DEFAULT_RECOVERY_DELAY_MS = 5_000;
export const DEFAULT_EXHAUST_WINDOW_MS = 30_000;

export function startCancelledToolRecovery(
  opts: StartCancelledToolRecoveryOptions,
): CancelledToolRecoveryHandle {
  const { deps } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_RECOVERY_INTERVAL_MS;
  const recoveryDelayMs =
    opts.recoveryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const exhaustWindowMs =
    opts.exhaustWindowMs ?? DEFAULT_EXHAUST_WINDOW_MS;
  const scheduler =
    opts.scheduler ??
    ({
      set: (fn: () => void, ms: number): unknown => {
        const t = setInterval(fn, ms);
        if (typeof (t as { unref?: () => void }).unref === 'function') {
          (t as { unref: () => void }).unref();
        }
        return t;
      },
      clear: (h: unknown): void => {
        try {
          clearInterval(h as NodeJS.Timeout);
        } catch {
          /* ignore */
        }
      },
    });

  function tick(): void {
    try {
      runCancelledToolRecoveryTick(deps, {
        recoveryDelayMs,
        exhaustWindowMs,
      });
    } catch (err) {
      (deps.log ?? (() => undefined))(
        `[cancelled-tool-recovery] tick threw: ${(err as Error).message}`,
      );
    }
  }

  const handle = scheduler.set(tick, intervalMs);

  return {
    stop(): void {
      scheduler.clear(handle);
    },
    tickNow(): void {
      tick();
    },
  };
}

interface TickConfig {
  recoveryDelayMs: number;
  exhaustWindowMs: number;
}

/* Exported for direct test invocation. Walks the jsonl tail for every
 * active brainstorm, updates per-session arm/clear state, then for
 * each armed session that has crossed the recoveryDelayMs window
 * fires the recovery inject (or the exhaustion escalation if a prior
 * recovery is still inside its strike window). */
export function runCancelledToolRecoveryTick(
  deps: CancelledToolRecoveryDeps,
  cfg: TickConfig,
): void {
  const list =
    deps.listActiveBrainstorms ??
    ((): BrainstormSessionRow[] =>
      deps.db.listBrainstorms({ status: 'active', limit: 200 }));
  const resolve = deps.resolveJsonlPath ?? defaultResolveJsonlPath;
  const readSince = deps.readSince ?? defaultReadSince;
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? ((): void => undefined);
  const inject =
    deps.crossSessionInject ??
    ((target: string, text: string, callerLabel: string): InjectResult =>
      crossSessionInject(
        {
          target_session: target,
          token: issueToken(target),
          text,
          caller_label: callerLabel,
          commit: true,
        },
        deps.db,
      ));
  const notify = deps.notifyExhausted ?? ((): void => undefined);

  const rows = list();
  for (const row of rows) {
    if (!row.claude_session_id) continue;
    const jsonl = resolve(row);
    if (!jsonl) continue;
    const ccId = row.claude_session_id;
    const key = offsetKey(row.id, ccId);
    const offset = offsets.get(key) ?? 0;
    const slice = readSince(jsonl, offset);
    if (!slice) continue;
    const text = slice.text;
    let lastComplete = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) !== 10) continue;
      const line = text.slice(lastComplete, i);
      lastComplete = i + 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry.isCompactSummary || entry.isMeta) continue;
      if (entry.type === 'user') {
        const toolText = extractToolResultText(entry);
        if (toolText && isRejectEnvelope(toolText)) {
          handleRejectEnvelope({
            row,
            ccId,
            uuid: typeof entry.uuid === 'string' ? entry.uuid : null,
            now,
            cfg,
            inject,
            notify,
            log,
            db: deps.db,
          });
        }
      } else if (entry.type === 'assistant') {
        /* Any new assistant line clears the armed state — Lex has
         * produced a follow-up on its own, so the recovery inject is
         * no longer needed. Strike counters persist (lastRecoveryAt
         * stays set) so a fresh cancellation within the 30 s window
         * still escalates to exhaustion. */
        const existing = stateMap.get(ccId);
        if (existing && existing.armedAt !== null) {
          log(
            `[cancelled-tool-recovery] cleared cc=${ccId.slice(0, 8)} (assistant follow-up landed)`,
          );
          existing.armedAt = null;
          existing.armedTurnUuid = null;
        }
      }
    }
    const completedBytes = Buffer.byteLength(
      text.slice(0, lastComplete),
      'utf-8',
    );
    offsets.set(key, offset + completedBytes);
  }

  /* Recovery firing loop. Walk every armed session and check whether
   * the recoveryDelayMs has elapsed since the arming event. */
  for (const [ccId, st] of stateMap) {
    if (st.armedAt === null) continue;
    if (now - st.armedAt < cfg.recoveryDelayMs) continue;
    /* Two-strike escalation: a fresh reject envelope landed inside
     * exhaustWindowMs after the previous recovery fired. Audit +
     * notify, do NOT inject again. */
    if (
      st.lastRecoveryAt !== null &&
      now - st.lastRecoveryAt < cfg.exhaustWindowMs
    ) {
      const reason = `recovery_exhausted: second cancellation within ${cfg.exhaustWindowMs} ms of prior recovery`;
      try {
        deps.db.insertCrossSessionLog({
          id: randomUUID(),
          target_session: ccId,
          caller_label: 'lex-cancelled-tool-recovery',
          text_preview: '[recovery_exhausted]',
          text_length: 0,
          decision: 'shadow',
          reject_reason: reason,
          brainstorm_id: st.brainstorm_id,
        });
      } catch {
        /* audit best-effort */
      }
      try {
        notify(ccId, reason);
      } catch {
        /* notify best-effort */
      }
      log(
        `[cancelled-tool-recovery] EXHAUSTED cc=${ccId.slice(0, 8)} bs=${st.brainstorm_id.slice(0, 8)} reason="${reason}"`,
      );
      st.armedAt = null;
      st.armedTurnUuid = null;
      continue;
    }
    const result = inject(ccId, RECOVERY_INJECT_BODY, 'lex-cancelled-tool-recovery');
    log(
      `[cancelled-tool-recovery] FIRED cc=${ccId.slice(0, 8)} bs=${st.brainstorm_id.slice(0, 8)} decision=${result.decision}${result.error ? ` error=${result.error}` : ''}`,
    );
    st.armedAt = null;
    st.armedTurnUuid = null;
    st.lastRecoveryAt = now;
  }
}

interface RejectContext {
  row: BrainstormSessionRow;
  ccId: string;
  uuid: string | null;
  now: number;
  cfg: TickConfig;
  inject: (
    target: string,
    text: string,
    callerLabel: string,
  ) => InjectResult;
  notify: (ccSessionId: string, reason: string) => void;
  log: (msg: string) => void;
  db: IndexDb;
}

function handleRejectEnvelope(ctx: RejectContext): void {
  const { row, ccId, uuid, now, cfg, log } = ctx;
  let st = stateMap.get(ccId);
  if (!st) {
    st = {
      brainstorm_id: row.id,
      cc_session_id: ccId,
      armedAt: null,
      armedTurnUuid: null,
      lastRecoveryAt: null,
    };
    stateMap.set(ccId, st);
  }
  /* Two-strike escalation guard at arm-time. A cancellation arriving
   * inside the strike window after a recovery already fired is the
   * recovery itself getting cancelled. Surface immediately rather
   * than waiting for the tick's firing pass — the firing pass would
   * otherwise debounce this back to a normal recovery attempt by
   * resetting armedAt. */
  if (
    st.lastRecoveryAt !== null &&
    now - st.lastRecoveryAt < cfg.exhaustWindowMs
  ) {
    const reason = `recovery_exhausted: cancellation arrived ${now - st.lastRecoveryAt} ms after prior recovery (window=${cfg.exhaustWindowMs} ms)`;
    try {
      ctx.db.insertCrossSessionLog({
        id: randomUUID(),
        target_session: ccId,
        caller_label: 'lex-cancelled-tool-recovery',
        text_preview: '[recovery_exhausted]',
        text_length: 0,
        decision: 'shadow',
        reject_reason: reason,
        brainstorm_id: row.id,
      });
    } catch {
      /* audit best-effort */
    }
    try {
      ctx.notify(ccId, reason);
    } catch {
      /* notify best-effort */
    }
    log(
      `[cancelled-tool-recovery] EXHAUSTED cc=${ccId.slice(0, 8)} bs=${row.id.slice(0, 8)} reason="${reason}"`,
    );
    /* Disarm so the firing pass does not auto-recover after this. */
    st.armedAt = null;
    st.armedTurnUuid = null;
    return;
  }
  /* Debounce: a second reject within the recovery delay window does
   * NOT restamp armedAt. Keeps the original timestamp so the firing
   * pass still fires exactly once for one logical interruption that
   * the user surfaced through two consecutive cancels. */
  if (st.armedAt !== null && now - st.armedAt < cfg.recoveryDelayMs) {
    log(
      `[cancelled-tool-recovery] debounced cc=${ccId.slice(0, 8)} (second cancellation within ${cfg.recoveryDelayMs} ms window)`,
    );
    return;
  }
  st.armedAt = now;
  st.armedTurnUuid = uuid;
  log(
    `[cancelled-tool-recovery] armed cc=${ccId.slice(0, 8)} bs=${row.id.slice(0, 8)} uuid=${uuid ?? '-'}`,
  );
}
