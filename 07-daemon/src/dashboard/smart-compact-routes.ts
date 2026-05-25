/**
 * Smart compact routes (SMART-COMPACT.md "Mechanics" + "Audit").
 *
 * v2 - Lex-authored resume prompts. The daemon no longer builds the
 * resume summary. Lex composes the prompt at fire time using live
 * conversation context and posts it as opts.summary on
 * /lex/smart-compact/fire. The daemon is transport + audit log only
 * for the summary inject. The wrap path stays daemon-authored
 * (WRAP_AND_COMMIT_PROMPT).
 *
 *   POST /lex/smart-compact/evaluate    {anchor_id}
 *     -> {action, reason, ctx_pct, shadow}  // no summary
 *
 *   POST /lex/smart-compact/fire        {anchor_id, reason, action,
 *                                        caller?, summary}
 *     -> 400 when action='fire' and summary is missing/empty.
 *        Otherwise writes audit row; if not shadow and the anchor
 *        has a current PTY, injects /clear then the caller-supplied
 *        summary. action='wrap' injects WRAP_AND_COMMIT_PROMPT and
 *        does NOT require summary.
 *
 *   GET  /lex/smart-compact/recent      ?limit=20
 *     -> {ok, rows: SmartCompactLogRow[]}
 *
 * Handlers are exported as pure functions over IndexDb + an injected
 * PTY transport so tests can drive them without spinning up fastify.
 * registerSmartCompactRoutes is the thin route binder.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { IndexDb, SmartCompactLogRow } from '../store/index-db.js';
import {
  defaults,
  evaluateTrigger,
  isShadow,
  WRAP_AND_COMMIT_PROMPT,
  type EvalAction,
  type EvalReason,
  type Phase,
} from '../lex/smart-compact.js';
import {
  awaitNewSessionReady,
  capturePreClearJsonlSet,
  ccProjectsDirForCwd,
  type SessionReadyResult,
} from './smart-compact-injector.js';

export interface PtyInjector {
  (
    ptyIdOrSession: string,
    text: string,
    commit: boolean,
  ): { ok: true } | { ok: false; error: string };
}

export interface EvaluateOptions {
  /** ctx_pct override; if absent the evaluator pulls from the anchor's
   * current transcript jsonl tail via the injected ctxProvider. */
  ctxPct?: number;
  ctxProvider?: (jsonlPath: string) => number | null;
  lastCommitMs?: number | null;
  lastToolMs?: number | null;
  phase?: Phase;
  now?: number;
}

export interface EvaluateResult {
  ok: boolean;
  error?: string;
  action: EvalAction;
  reason: EvalReason;
  ctx_pct: number | null;
  shadow: boolean;
  jsonl_path: string | null;
  anchor_id: string;
}

export function jsonlForAnchor(db: IndexDb, anchorId: string): string | null {
  const refs = db.listProjectTranscriptRefs(anchorId);
  if (refs.length === 0) return null;
  return refs[refs.length - 1]!.jsonl_path;
}

function deriveLastTool(jsonlPath: string | null): number | null {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return null;
  try {
    const stat = fs.statSync(jsonlPath);
    const tailLen = Math.min(stat.size, 16 * 1024);
    const start = stat.size - tailLen;
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(tailLen);
      fs.readSync(fd, buf, 0, tailLen, start);
      const text = buf.toString('utf-8');
      const lines = text.split('\n').filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line.includes('tool_use') && !line.includes('"type":"tool"')) {
          continue;
        }
        try {
          const rec = JSON.parse(line) as { timestamp?: string };
          if (rec.timestamp) {
            const ms = Date.parse(rec.timestamp);
            if (Number.isFinite(ms)) return ms;
          }
        } catch {
          continue;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* fall through */
  }
  return null;
}

function deriveLastCommit(cwd: string): number | null {
  if (!cwd || !fs.existsSync(cwd)) return null;
  try {
    const out = execFileSync(
      'git',
      ['-C', cwd, 'log', '-1', '--format=%ct'],
      { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const sec = Number(out);
    return Number.isFinite(sec) ? sec * 1000 : null;
  } catch {
    return null;
  }
}

export async function evaluateSmartCompact(
  db: IndexDb,
  anchorId: string,
  opts: EvaluateOptions = {},
): Promise<EvaluateResult> {
  const anchor = db.getProjectSession(anchorId);
  if (!anchor) {
    return {
      ok: false,
      error: 'anchor not found',
      action: 'wait',
      reason: 'below-window',
      ctx_pct: null,
      shadow: false,
      jsonl_path: null,
      anchor_id: anchorId,
    };
  }
  const jsonlPath = jsonlForAnchor(db, anchorId);
  let ctxPct: number | null = opts.ctxPct ?? null;
  if (ctxPct === null && jsonlPath && opts.ctxProvider) {
    ctxPct = opts.ctxProvider(jsonlPath);
  }
  if (ctxPct === null) {
    return {
      ok: true,
      action: 'wait',
      reason: 'below-window',
      ctx_pct: null,
      shadow: isShadow(db, anchorId),
      jsonl_path: jsonlPath,
      anchor_id: anchorId,
    };
  }
  const cfg = defaults();
  const now = opts.now ?? Date.now();
  const lastCommitMs =
    opts.lastCommitMs ?? deriveLastCommit(anchor.cwd);
  const lastToolMs = opts.lastToolMs ?? deriveLastTool(jsonlPath);
  const phase = opts.phase ?? 'unknown';
  const verdict = evaluateTrigger({
    ctxPct,
    threshold: cfg.threshold,
    bandHalf: cfg.bandHalf,
    hardCeiling: cfg.hardCeiling,
    stopWindowMs: cfg.stopWindowMs,
    now,
    lastCommitMs,
    lastToolMs,
    phase,
  });
  const shadow = isShadow(db, anchorId);
  return {
    ok: true,
    action: verdict.action,
    reason: verdict.reason,
    ctx_pct: ctxPct,
    shadow,
    jsonl_path: jsonlPath,
    anchor_id: anchorId,
  };
}

export interface FireOptions {
  caller: string;
  reason: EvalReason | 'manual';
  action: EvalAction;
  ctxPct: number | null;
  summary?: string;
  injector: PtyInjector;
  /** Override the shadow gate (e.g. user forced a real fire from the
   * dashboard). When true, the audit row uses action as provided and
   * inject runs regardless of the shadow count. */
  force?: boolean;
  /** Optional event-driven readiness gate for the resume summary
   * paste. When provided AND action='fire' AND the path is not
   * shadow/off, fireSmartCompact runs /clear synchronously, then
   * kicks off a fire-and-forget async sequence that awaits this
   * gate before injecting the summary. If the gate resolves with
   * ready=false the sequence falls back to a 850ms wait so the
   * summary still ships. Tests that omit this option exercise the
   * legacy back-to-back inject path (the 24-test regression). */
  awaitSessionReady?: () => Promise<SessionReadyResult>;
  /** Fallback wait when awaitSessionReady resolves !ready. Default
   * 850ms - the legacy time-based settle window. */
  fallbackWaitMs?: number;
  /** Notification of the deferred summary inject's outcome. Fires
   * exactly once when awaitSessionReady is configured, after the
   * summary inject resolves. Best-effort; failures swallowed. */
  onResumeComplete?: (info: {
    ship_ok: boolean;
    wait: SessionReadyResult | null;
  }) => void;
}

export interface FireResult {
  ok: boolean;
  action: EvalAction | 'shadow';
  shadow: boolean;
  log_id: string;
  inject_result?:
    | 'accepted'
    | 'pty_not_found'
    | 'wrap-injected'
    | 'accepted-pending-ready';
  anchor_id: string;
}

/* Three-state global kill-switch.
 *
 * Resolution order:
 *   1. runtime_config.smart_compact_mode   (dashboard toggle, hot)
 *   2. DEVNEURAL_SMART_COMPACT_ENABLED env var (initial-default
 *      fallback only; once runtime_config is set the env stops
 *      mattering until it's cleared)
 *   3. default = 'shadow'
 *
 * Modes:
 *   off    — fireSmartCompact short-circuits to action='noop'. No
 *            audit row, no PTY inject. Smart compact entirely inert
 *            for the host. Useful when a misconfigured threshold or
 *            a runaway evaluator is spamming /clear and the
 *            operator needs to drop the system without bouncing the
 *            daemon.
 *   shadow — shadow audit rows always; PTY inject never runs. The
 *            old default behaviour when smartCompactGloballyEnabled
 *            returned false. Used to validate trigger conditions on
 *            a new anchor before opting it in.
 *   live   — per-anchor isShadow() decides. Anchor in shadow mode →
 *            shadow row, no inject. Otherwise inject + fire/wrap
 *            row.
 *
 * Back-compat: env truthy spellings ('true', '1', 'on', 'live') map
 * to 'live'; falsey spellings ('false', '0', 'off') map to 'off';
 * 'shadow' maps through. Unknown / unset env stays at default. */
const SMART_COMPACT_CONFIG_KEY = 'smart_compact_mode';
export type SmartCompactMode = 'off' | 'shadow' | 'live';

export function parseSmartCompactValue(
  raw: string | null | undefined,
): SmartCompactMode | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === '') return null;
  if (v === 'off' || v === 'false' || v === '0') return 'off';
  if (v === 'shadow') return 'shadow';
  if (v === 'live' || v === 'on' || v === 'true' || v === '1') return 'live';
  return null;
}

export function smartCompactMode(db: IndexDb): SmartCompactMode {
  const fromRuntime = parseSmartCompactValue(
    db.getRuntimeConfig(SMART_COMPACT_CONFIG_KEY),
  );
  if (fromRuntime) return fromRuntime;
  const fromEnv = parseSmartCompactValue(
    process.env.DEVNEURAL_SMART_COMPACT_ENABLED,
  );
  if (fromEnv) return fromEnv;
  return 'shadow';
}

/* Compat shim. Callers that historically checked the env-driven
 * boolean kill-switch now read through the three-state resolver and
 * treat 'live' as enabled. Kept as a function so future callers can
 * still grep for the same name. */
export function smartCompactGloballyEnabled(db: IndexDb): boolean {
  return smartCompactMode(db) === 'live';
}

export { SMART_COMPACT_CONFIG_KEY };

export function fireSmartCompact(
  db: IndexDb,
  anchorId: string,
  opts: FireOptions,
): FireResult {
  const anchor = db.getProjectSession(anchorId);
  const mode = smartCompactMode(db);

  /* 'off' short-circuits before we touch the audit log so the
   * operator can drop the system cold without a row landing on every
   * evaluate-driven fire request. force=true does NOT override this:
   * the off state is supposed to be inert. */
  if (mode === 'off') {
    return {
      ok: true,
      action: 'shadow',
      shadow: true,
      log_id: '',
      anchor_id: anchorId,
    };
  }

  const globallyDisabled = mode !== 'live';
  const shadow =
    globallyDisabled || (!opts.force && isShadow(db, anchorId));

  if (shadow) {
    const logId = randomUUID();
    db.insertSmartCompactLog({
      id: logId,
      anchor_id: anchorId,
      cc_session_id: anchor?.current_session_id ?? null,
      caller: opts.caller,
      reason: opts.reason,
      action: 'shadow',
      pre_ctx_pct: opts.ctxPct,
      summary_preview: opts.summary?.slice(0, 280) ?? null,
      payload_text:
        opts.action === 'wrap'
          ? WRAP_AND_COMMIT_PROMPT
          : opts.summary ?? null,
    });
    return {
      ok: true,
      action: 'shadow',
      shadow: true,
      log_id: logId,
      anchor_id: anchorId,
    };
  }

  /* Pick a target the injector can resolve. Prefer current_pty_id
   * when the anchor was bound to a daemon-owned PTY; fall back to
   * current_session_id when the anchor is bound to a bridge-only
   * session (worker launched outside the daemon, e.g. via the
   * dashboard "Sessions" button or a VS Code-side claude). The
   * route-level injector wired in registerSmartCompactRoutes does
   * listPtys-then-bridge resolution against this string, mirroring
   * the cross-session-inject path that already handles both
   * transports. Without this fallback, fireSmartCompact returned
   * pty_not_found on every bridge-bound anchor and the worker never
   * actually received /clear + the resume summary. */
  const target =
    anchor?.current_pty_id ?? anchor?.current_session_id ?? null;
  let injectResult: FireResult['inject_result'] = 'pty_not_found';
  if (target) {
    if (opts.action === 'wrap') {
      const r = opts.injector(target, WRAP_AND_COMMIT_PROMPT, true);
      injectResult = r.ok ? 'wrap-injected' : 'pty_not_found';
    } else if (opts.awaitSessionReady) {
      /* Event-driven path: /clear synchronously, then wait for the
       * fresh CC session to finish its SessionStart attachment chain
       * before pasting the resume summary. Without this gate the
       * summary's auto-CR nudge fired during the new-session init
       * window and got swallowed, parking the summary in the input
       * box. The /clear inject result is reflected in the audit row
       * upfront; the summary inject is fire-and-forget and surfaced
       * via onResumeComplete. */
      const cleared = opts.injector(target, '/clear', true);
      if (!cleared.ok) {
        injectResult = 'pty_not_found';
      } else {
        injectResult = 'accepted-pending-ready';
        const summary = opts.summary ?? '';
        const fallbackWaitMs = opts.fallbackWaitMs ?? 850;
        void (async () => {
          let wait: SessionReadyResult | null = null;
          try {
            wait = await opts.awaitSessionReady!();
          } catch {
            wait = null;
          }
          if (!wait || !wait.ready) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, fallbackWaitMs);
              if (typeof (t as { unref?: () => void }).unref === 'function') {
                (t as { unref: () => void }).unref();
              }
            });
          }
          /* Fix 15 C3 — replay parked injects before the resume
           * summary fires. Bounded to 3 entries per resume window so
           * a stuck audit row can't trigger a self-amplifying replay
           * loop. The new CC session uuid (if observable) is read
           * from wait.new_jsonl so the audit rows can be amended to
           * record where the replay actually landed. */
          let replayedToSession: string | null = null;
          if (wait?.ready && wait.new_jsonl) {
            const base = wait.new_jsonl.split('/').pop() ?? '';
            replayedToSession = base.replace(/\.jsonl$/, '') || null;
          }
          try {
            const parked = db.findParkedInjectsForAnchor(anchorId, {
              limit: 3,
              sinceMs: 5 * 60 * 1000,
            });
            for (const row of parked) {
              if (!row.payload_text) continue;
              const r = opts.injector(target, row.payload_text, true);
              if (r.ok) {
                db.markParkedInjectReplayed(
                  row.id,
                  replayedToSession ?? target,
                );
              }
            }
          } catch {
            /* replay is best-effort; never block the summary */
          }
          const ship = opts.injector(target, summary, true);
          try {
            opts.onResumeComplete?.({ ship_ok: ship.ok, wait });
          } catch {
            /* observational */
          }
        })();
      }
    } else {
      /* Legacy back-to-back path: /clear then summary inline. Two
       * injects with the existing 80ms paste-then-Enter delay built
       * into ptyInject. Tests exercise this branch by omitting
       * awaitSessionReady. */
      const cleared = opts.injector(target, '/clear', true);
      const summary = opts.summary ?? '';
      const ship = opts.injector(target, summary, true);
      injectResult = cleared.ok && ship.ok ? 'accepted' : 'pty_not_found';
    }
  }

  const logId = randomUUID();
  db.insertSmartCompactLog({
    id: logId,
    anchor_id: anchorId,
    cc_session_id: anchor?.current_session_id ?? null,
    caller: opts.caller,
    reason: opts.reason,
    action: opts.action === 'wait' ? 'noop' : opts.action,
    pre_ctx_pct: opts.ctxPct,
    summary_preview: opts.summary?.slice(0, 280) ?? null,
    payload_text:
      opts.action === 'wrap'
        ? WRAP_AND_COMMIT_PROMPT
        : opts.summary ?? null,
  });

  return {
    ok: injectResult === 'accepted' || injectResult === 'wrap-injected',
    action: opts.action === 'wait' ? 'wait' : opts.action,
    shadow: false,
    log_id: logId,
    inject_result: injectResult,
    anchor_id: anchorId,
  };
}

export function recentSmartCompacts(
  db: IndexDb,
  limit: number = 20,
): SmartCompactLogRow[] {
  return db.listRecentSmartCompacts(limit);
}

export function registerSmartCompactRoutes(
  app: FastifyInstance,
  db: IndexDb,
  injector: PtyInjector,
  log: (msg: string) => void = () => undefined,
): void {
  app.post('/lex/smart-compact/evaluate', async (req, reply) => {
    const body = (req.body ?? {}) as {
      anchor_id?: string;
      ctx_pct?: number;
      phase?: Phase;
    };
    if (!body.anchor_id) {
      reply.code(400);
      return { ok: false, error: 'anchor_id required' };
    }
    const r = await evaluateSmartCompact(db, body.anchor_id, {
      ctxPct: typeof body.ctx_pct === 'number' ? body.ctx_pct : undefined,
      phase: body.phase,
    });
    if (!r.ok) reply.code(404);
    return r;
  });

  app.post('/lex/smart-compact/fire', async (req, reply) => {
    const body = (req.body ?? {}) as {
      anchor_id?: string;
      reason?: EvalReason | 'manual';
      action?: EvalAction;
      ctx_pct?: number;
      summary?: string;
      caller?: string;
      force?: boolean;
    };
    if (!body.anchor_id || !body.reason || !body.action) {
      reply.code(400);
      return { ok: false, error: 'anchor_id, reason, action required' };
    }
    /* v2 - Lex-authored resume prompt. The daemon no longer builds the
     * summary. action='fire' requires a non-empty caller-supplied
     * summary; rejecting up-front prevents an empty inject pasting a
     * blank line into the freshly-cleared worker. action='wrap' uses
     * the daemon-authored WRAP_AND_COMMIT_PROMPT and does not take a
     * caller summary. */
    if (body.action === 'fire') {
      const s = typeof body.summary === 'string' ? body.summary.trim() : '';
      if (!s) {
        reply.code(400);
        return {
          ok: false,
          error:
            "summary is required and must be non-empty when action='fire' (v2: Lex-authored)",
        };
      }
    }
    /* Build the event-driven readiness gate for the resume summary
     * paste. Skipped for action='wrap' since wrap does a single
     * inject. Skipped when the anchor has no resolvable cwd (no
     * project dir to watch) - fireSmartCompact will fall back to the
     * legacy back-to-back inject in that case. */
    let awaitSessionReady: (() => Promise<SessionReadyResult>) | undefined;
    if (body.action === 'fire') {
      const anchor = db.getProjectSession(body.anchor_id);
      if (anchor?.cwd) {
        const ccProjectsDir = ccProjectsDirForCwd(os.homedir(), anchor.cwd);
        const preClearFiles = capturePreClearJsonlSet(ccProjectsDir);
        awaitSessionReady = () =>
          awaitNewSessionReady({
            ccProjectsDir,
            preClearFiles,
            io: { log: (msg) => log(msg) },
          });
      }
    }
    const r = fireSmartCompact(db, body.anchor_id, {
      caller: body.caller ?? 'lex',
      reason: body.reason,
      action: body.action,
      ctxPct: typeof body.ctx_pct === 'number' ? body.ctx_pct : null,
      summary: body.summary,
      injector,
      force: body.force === true,
      ...(awaitSessionReady ? { awaitSessionReady } : {}),
      onResumeComplete: (info) => {
        log(
          `[smart-compact] resume ship_ok=${info.ship_ok} wait=${info.wait?.reason ?? 'none'} elapsed=${info.wait?.elapsed_ms ?? 0}ms`,
        );
      },
    });
    log(
      `[smart-compact] anchor=${body.anchor_id} reason=${body.reason} action=${r.action} shadow=${r.shadow} inject=${r.inject_result ?? 'n/a'}`,
    );
    return r;
  });

  app.get('/lex/smart-compact/recent', async (req) => {
    const q = (req.query ?? {}) as { limit?: string };
    const limit = q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 20;
    return { ok: true, rows: recentSmartCompacts(db, limit) };
  });

  /* GET + POST /lex/smart-compact/toggle
   *
   * Three-state runtime kill-switch backing fireSmartCompact. Reads
   * + writes runtime_config so the flip takes effect on the next
   * fire request without a daemon restart. Mirrors the shape of
   * /lex/cold-start-preload/toggle so the dashboard panel can be a
   * near-clone.
   *
   * GET response:
   *   { ok, mode, runtime_value, env_value, default_mode } */
  app.get('/lex/smart-compact/toggle', async () => {
    const runtimeValue = db.getRuntimeConfig(SMART_COMPACT_CONFIG_KEY);
    const envValue = process.env.DEVNEURAL_SMART_COMPACT_ENABLED ?? null;
    return {
      ok: true,
      mode: smartCompactMode(db),
      runtime_value: runtimeValue,
      env_value: envValue,
      default_mode: 'shadow',
    };
  });

  app.post('/lex/smart-compact/toggle', async (req, reply) => {
    const body = (req.body ?? {}) as {
      mode?: string;
      updated_by?: string;
    };
    const next = parseSmartCompactValue(body.mode);
    if (!next) {
      reply.code(400);
      return {
        ok: false,
        error: "mode must be 'off' | 'shadow' | 'live'",
      };
    }
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, next, body.updated_by);
    log(`[smart-compact] mode -> ${next} by=${body.updated_by ?? 'unknown'}`);
    return {
      ok: true,
      mode: smartCompactMode(db),
      runtime_value: db.getRuntimeConfig(SMART_COMPACT_CONFIG_KEY),
      env_value: process.env.DEVNEURAL_SMART_COMPACT_ENABLED ?? null,
      default_mode: 'shadow',
    };
  });
}
