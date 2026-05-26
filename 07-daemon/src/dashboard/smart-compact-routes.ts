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

/* Fix 41 Stage 2 — policy-owner runtime flag.
 *
 * Resolution order:
 *   1. runtime_config.smart_compact_policy_owner   (dashboard toggle)
 *   2. default = 'daemon'
 *
 * Values:
 *   daemon — legacy path. The 60s scheduler still walks anchors and
 *            fires wrap / defers fire to Lex (per Fix 36).
 *   lex    — scheduler short-circuits to log-only. Lex drives the
 *            entire loop via the new state + clear-and-paste +
 *            wrap-paste endpoints. Stage 3 removes the daemon scheduler
 *            entirely; Stage 2 keeps it as the rollback path.
 *
 * Default stays 'daemon' through Stage 2 so the flip is opt-in until
 * the Lex loop is verified. */
const SMART_COMPACT_POLICY_OWNER_KEY = 'smart_compact_policy_owner';
export type SmartCompactPolicyOwner = 'daemon' | 'lex';

export function parseSmartCompactPolicyOwner(
  raw: string | null | undefined,
): SmartCompactPolicyOwner | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'daemon') return 'daemon';
  if (v === 'lex') return 'lex';
  return null;
}

export function smartCompactPolicyOwner(db: IndexDb): SmartCompactPolicyOwner {
  const fromRuntime = parseSmartCompactPolicyOwner(
    db.getRuntimeConfig(SMART_COMPACT_POLICY_OWNER_KEY),
  );
  return fromRuntime ?? 'daemon';
}

export { SMART_COMPACT_POLICY_OWNER_KEY };

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

/* Fix 41 Stage 1 — policy-out endpoints.
 *
 * The three handlers below (state, clearAndPaste, wrapPaste) live
 * outside registerSmartCompactRoutes as pure functions so tests can
 * drive them with stub injectors and a stub ctxProvider. The route
 * binder in registerSmartCompactRoutes wraps them with HTTP request
 * decoding + response shaping; the underlying mechanics are identical.
 *
 * Section 1 audit of the investigation doc routed these handlers as
 * the "mechanical-only" replacements for the daemon's prior policy
 * surface. They never read defaults(), never call evaluateTrigger,
 * never consult isShadow. Lex computes the decision and posts a
 * concrete action; the daemon transports it. The off-mode global
 * kill-switch is the ONLY policy gate that stays daemon-side, because
 * it is the operator-level "drop the whole pipeline" toggle and Lex
 * must not be able to override it. */

export interface StateResult {
  ok: boolean;
  error?: string;
  anchor_id: string;
  ctx_pct: number | null;
  last_commit_ms: number | null;
  last_tool_ms: number | null;
  jsonl_path: string | null;
  shadow_count: number;
  mode: SmartCompactMode;
}

export interface StateOptions {
  ctxProvider?: (jsonlPath: string) => number | null;
  lastCommitProvider?: (cwd: string) => number | null;
  lastToolProvider?: (jsonlPath: string) => number | null;
}

export function readSmartCompactState(
  db: IndexDb,
  anchorId: string,
  opts: StateOptions = {},
): StateResult {
  const anchor = db.getProjectSession(anchorId);
  if (!anchor) {
    return {
      ok: false,
      error: 'anchor not found',
      anchor_id: anchorId,
      ctx_pct: null,
      last_commit_ms: null,
      last_tool_ms: null,
      jsonl_path: null,
      shadow_count: 0,
      mode: smartCompactMode(db),
    };
  }
  const jsonlPath = jsonlForAnchor(db, anchorId);
  const ctxProvider = opts.ctxProvider;
  const lastCommitProvider = opts.lastCommitProvider ?? deriveLastCommit;
  const lastToolProvider = opts.lastToolProvider ?? deriveLastTool;
  const ctxPct =
    jsonlPath && ctxProvider ? ctxProvider(jsonlPath) : null;
  const lastCommitMs = anchor.cwd ? lastCommitProvider(anchor.cwd) : null;
  const lastToolMs = jsonlPath ? lastToolProvider(jsonlPath) : null;
  const shadowCount = db.countSmartCompactsForAnchor(anchorId);
  return {
    ok: true,
    anchor_id: anchorId,
    ctx_pct: ctxPct,
    last_commit_ms: lastCommitMs,
    last_tool_ms: lastToolMs,
    jsonl_path: jsonlPath,
    shadow_count: shadowCount,
    mode: smartCompactMode(db),
  };
}

export interface ClearAndPasteOptions {
  caller?: string;
  reason: string;
  summary: string;
  preCtxPct?: number | null;
  useReadinessGate?: boolean;
  injector: PtyInjector;
  awaitSessionReady?: () => Promise<SessionReadyResult>;
  fallbackWaitMs?: number;
  onResumeComplete?: (info: {
    ship_ok: boolean;
    wait: SessionReadyResult | null;
  }) => void;
}

export interface ClearAndPasteResult {
  ok: boolean;
  error?: string;
  log_id: string;
  inject_result:
    | 'accepted'
    | 'accepted-pending-ready'
    | 'pty_not_found'
    | 'noop';
  anchor_id: string;
}

export function clearAndPaste(
  db: IndexDb,
  anchorId: string,
  opts: ClearAndPasteOptions,
): ClearAndPasteResult {
  const summary = (opts.summary ?? '').trim();
  if (!summary) {
    return {
      ok: false,
      error: 'summary is required and must be non-empty',
      log_id: '',
      inject_result: 'pty_not_found',
      anchor_id: anchorId,
    };
  }
  const anchor = db.getProjectSession(anchorId);
  if (!anchor) {
    return {
      ok: false,
      error: 'anchor not found',
      log_id: '',
      inject_result: 'pty_not_found',
      anchor_id: anchorId,
    };
  }
  const mode = smartCompactMode(db);
  /* off short-circuits before audit + inject so the operator-level
   * kill-switch is truly inert. Matches fireSmartCompact's off-mode
   * semantics. */
  if (mode === 'off') {
    return {
      ok: true,
      log_id: '',
      inject_result: 'noop',
      anchor_id: anchorId,
    };
  }
  const target = anchor.current_pty_id ?? anchor.current_session_id ?? null;
  if (!target) {
    return {
      ok: false,
      error: 'no resolvable target for anchor',
      log_id: '',
      inject_result: 'pty_not_found',
      anchor_id: anchorId,
    };
  }

  const useGate = opts.useReadinessGate !== false && !!opts.awaitSessionReady;
  let injectResult: ClearAndPasteResult['inject_result'] = 'pty_not_found';
  if (useGate) {
    const cleared = opts.injector(target, '/clear', true);
    if (!cleared.ok) {
      injectResult = 'pty_not_found';
    } else {
      injectResult = 'accepted-pending-ready';
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
        const ship = opts.injector(target, summary, true);
        try {
          opts.onResumeComplete?.({ ship_ok: ship.ok, wait });
        } catch {
          /* observational */
        }
      })();
    }
  } else {
    const cleared = opts.injector(target, '/clear', true);
    const ship = opts.injector(target, summary, true);
    injectResult = cleared.ok && ship.ok ? 'accepted' : 'pty_not_found';
  }

  const logId = randomUUID();
  db.insertSmartCompactLog({
    id: logId,
    anchor_id: anchorId,
    cc_session_id: anchor.current_session_id ?? null,
    caller: opts.caller ?? 'lex',
    reason: opts.reason,
    action: 'clear-and-paste',
    pre_ctx_pct: opts.preCtxPct ?? null,
    summary_preview: summary.slice(0, 280),
    payload_text: summary,
  });

  return {
    ok:
      injectResult === 'accepted' || injectResult === 'accepted-pending-ready',
    log_id: logId,
    inject_result: injectResult,
    anchor_id: anchorId,
  };
}

export interface WrapPasteOptions {
  caller?: string;
  reason: string;
  prompt: string;
  preCtxPct?: number | null;
  injector: PtyInjector;
}

export interface WrapPasteResult {
  ok: boolean;
  error?: string;
  log_id: string;
  inject_result: 'wrap-injected' | 'pty_not_found' | 'noop';
  anchor_id: string;
}

export function wrapPaste(
  db: IndexDb,
  anchorId: string,
  opts: WrapPasteOptions,
): WrapPasteResult {
  const prompt = (opts.prompt ?? '').trim();
  if (!prompt) {
    return {
      ok: false,
      error: 'prompt is required and must be non-empty',
      log_id: '',
      inject_result: 'pty_not_found',
      anchor_id: anchorId,
    };
  }
  const anchor = db.getProjectSession(anchorId);
  if (!anchor) {
    return {
      ok: false,
      error: 'anchor not found',
      log_id: '',
      inject_result: 'pty_not_found',
      anchor_id: anchorId,
    };
  }
  const mode = smartCompactMode(db);
  if (mode === 'off') {
    return {
      ok: true,
      log_id: '',
      inject_result: 'noop',
      anchor_id: anchorId,
    };
  }
  const target = anchor.current_pty_id ?? anchor.current_session_id ?? null;
  if (!target) {
    return {
      ok: false,
      error: 'no resolvable target for anchor',
      log_id: '',
      inject_result: 'pty_not_found',
      anchor_id: anchorId,
    };
  }
  const r = opts.injector(target, prompt, true);
  const injectResult: WrapPasteResult['inject_result'] = r.ok
    ? 'wrap-injected'
    : 'pty_not_found';
  const logId = randomUUID();
  db.insertSmartCompactLog({
    id: logId,
    anchor_id: anchorId,
    cc_session_id: anchor.current_session_id ?? null,
    caller: opts.caller ?? 'lex',
    reason: opts.reason,
    action: 'wrap-paste',
    pre_ctx_pct: opts.preCtxPct ?? null,
    summary_preview: prompt.slice(0, 280),
    payload_text: prompt,
  });
  return {
    ok: r.ok,
    log_id: logId,
    inject_result: injectResult,
    anchor_id: anchorId,
  };
}

export interface RegisterOptions {
  ctxProvider?: (jsonlPath: string) => number | null;
}

export function registerSmartCompactRoutes(
  app: FastifyInstance,
  db: IndexDb,
  injector: PtyInjector,
  log: (msg: string) => void = () => undefined,
  options: RegisterOptions = {},
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

  /* Fix 41 Stage 1 — policy-out endpoints.
   *
   * GET /lex/smart-compact/state returns the raw inputs Lex needs to
   * run evaluateTrigger locally (ctx_pct, last_commit_ms, last_tool_ms,
   * jsonl_path, shadow_count, mode). No decision, no inject, no audit
   * row. Lex polls this on its own cadence. */
  app.get('/lex/smart-compact/state', async (req, reply) => {
    const q = (req.query ?? {}) as { anchor_id?: string };
    if (!q.anchor_id) {
      reply.code(400);
      return { ok: false, error: 'anchor_id required' };
    }
    const r = readSmartCompactState(db, q.anchor_id, {
      ...(options.ctxProvider ? { ctxProvider: options.ctxProvider } : {}),
    });
    if (!r.ok) reply.code(404);
    return r;
  });

  /* POST /lex/smart-compact/clear-and-paste. Lex-supplied summary;
   * daemon runs /clear + readiness gate + summary paste + audit row.
   * No threshold check, no window math, no shadow gating. */
  app.post('/lex/smart-compact/clear-and-paste', async (req, reply) => {
    const body = (req.body ?? {}) as {
      anchor_id?: string;
      summary?: string;
      reason?: string;
      caller?: string;
      pre_ctx_pct?: number;
      use_readiness_gate?: boolean;
    };
    if (!body.anchor_id) {
      reply.code(400);
      return { ok: false, error: 'anchor_id required' };
    }
    const summary =
      typeof body.summary === 'string' ? body.summary.trim() : '';
    if (!summary) {
      reply.code(400);
      return {
        ok: false,
        error:
          'summary is required and must be non-empty (Fix 41: Lex-authored)',
      };
    }
    if (!body.reason) {
      reply.code(400);
      return { ok: false, error: 'reason required' };
    }
    const anchor = db.getProjectSession(body.anchor_id);
    if (!anchor) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    /* Build the optional readiness gate the same way the legacy /fire
     * route did. Skipped when the anchor has no resolvable cwd, or
     * when the caller explicitly passes use_readiness_gate=false. */
    let awaitSessionReady: (() => Promise<SessionReadyResult>) | undefined;
    if (body.use_readiness_gate !== false && anchor.cwd) {
      const ccProjectsDir = ccProjectsDirForCwd(os.homedir(), anchor.cwd);
      const preClearFiles = capturePreClearJsonlSet(ccProjectsDir);
      awaitSessionReady = () =>
        awaitNewSessionReady({
          ccProjectsDir,
          preClearFiles,
          io: { log: (msg) => log(msg) },
        });
    }
    const r = clearAndPaste(db, body.anchor_id, {
      ...(body.caller !== undefined ? { caller: body.caller } : {}),
      reason: body.reason,
      summary: body.summary ?? '',
      preCtxPct:
        typeof body.pre_ctx_pct === 'number' ? body.pre_ctx_pct : null,
      ...(body.use_readiness_gate !== undefined
        ? { useReadinessGate: body.use_readiness_gate }
        : {}),
      injector,
      ...(awaitSessionReady ? { awaitSessionReady } : {}),
      onResumeComplete: (info) => {
        log(
          `[smart-compact] clear-and-paste resume ship_ok=${info.ship_ok} wait=${info.wait?.reason ?? 'none'} elapsed=${info.wait?.elapsed_ms ?? 0}ms`,
        );
      },
    });
    log(
      `[smart-compact] anchor=${body.anchor_id} action=clear-and-paste reason=${body.reason} inject=${r.inject_result}`,
    );
    return r;
  });

  /* POST /lex/smart-compact/wrap-paste. Lex-authored wrap prompt;
   * daemon injects once + writes audit row. No daemon-side
   * WRAP_AND_COMMIT_PROMPT default. */
  app.post('/lex/smart-compact/wrap-paste', async (req, reply) => {
    const body = (req.body ?? {}) as {
      anchor_id?: string;
      prompt?: string;
      reason?: string;
      caller?: string;
      pre_ctx_pct?: number;
    };
    if (!body.anchor_id) {
      reply.code(400);
      return { ok: false, error: 'anchor_id required' };
    }
    const prompt =
      typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      reply.code(400);
      return {
        ok: false,
        error:
          'prompt is required and must be non-empty (Fix 41: Lex-authored)',
      };
    }
    if (!body.reason) {
      reply.code(400);
      return { ok: false, error: 'reason required' };
    }
    const anchor = db.getProjectSession(body.anchor_id);
    if (!anchor) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    const r = wrapPaste(db, body.anchor_id, {
      ...(body.caller !== undefined ? { caller: body.caller } : {}),
      reason: body.reason,
      prompt: body.prompt ?? '',
      preCtxPct:
        typeof body.pre_ctx_pct === 'number' ? body.pre_ctx_pct : null,
      injector,
    });
    log(
      `[smart-compact] anchor=${body.anchor_id} action=wrap-paste reason=${body.reason} inject=${r.inject_result}`,
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

  /* Fix 41 Stage 2 — policy-owner toggle.
   *
   * GET returns the current owner ('daemon' | 'lex') and the raw
   * runtime_config row so the dashboard can show why the value is
   * what it is. POST flips the runtime value (no daemon restart
   * required); on the next scheduler tick the short-circuit branch
   * either runs or doesn't. Default stays 'daemon' through Stage 2;
   * Stage 3 deletes the toggle and the scheduler. */
  app.get('/lex/smart-compact/policy-owner', async () => {
    const runtimeValue = db.getRuntimeConfig(SMART_COMPACT_POLICY_OWNER_KEY);
    return {
      ok: true,
      owner: smartCompactPolicyOwner(db),
      runtime_value: runtimeValue,
      default_owner: 'daemon' as SmartCompactPolicyOwner,
    };
  });

  app.post('/lex/smart-compact/policy-owner', async (req, reply) => {
    const body = (req.body ?? {}) as {
      owner?: string;
      updated_by?: string;
    };
    const next = parseSmartCompactPolicyOwner(body.owner);
    if (!next) {
      reply.code(400);
      return {
        ok: false,
        error: "owner must be 'daemon' | 'lex'",
      };
    }
    db.setRuntimeConfig(
      SMART_COMPACT_POLICY_OWNER_KEY,
      next,
      body.updated_by,
    );
    log(
      `[smart-compact] policy-owner -> ${next} by=${body.updated_by ?? 'unknown'}`,
    );
    return {
      ok: true,
      owner: smartCompactPolicyOwner(db),
      runtime_value: db.getRuntimeConfig(SMART_COMPACT_POLICY_OWNER_KEY),
      default_owner: 'daemon' as SmartCompactPolicyOwner,
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
