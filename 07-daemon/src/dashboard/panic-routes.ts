/**
 * Panic button routes (PANIC-BUTTON.md steps 1, 3, 7).
 *
 * Three handler entry points:
 *   firePanic            -> POST /panic                  global single-target
 *   fireProjectInterrupt -> POST /projects/:id/interrupt anchor-pinned
 *   recentPanics         -> GET  /panic/recent           audit panel feed
 *
 * Every fire writes one panic_log row with result in
 * {accepted, pty_not_found, no_target, bridge_esc}. The PTY transport
 * is injected so unit tests don't need a real PTY (production binds
 * to ptyInject from pty-host).
 *
 * Dual transport (control-transport fix, 2026-07-14). Bridge-attached
 * workers (project_session.current_pty_id null, current_bridge_id
 * set — a VS Code terminal Lex never spawned as a daemon PTY) have no
 * daemon-owned PTY for the raw injector to write \x1b\x1b into, so
 * every panic against one of those anchors used to log
 * 'pty_not_found' even while the worker was live and reachable. When
 * the PTY attempt misses, fireOn now retries the SAME 2-byte ESC ESC
 * payload through the bridge's suggestion queue (commit:false — a raw
 * escape has nothing to commit) gated on real bridge deliverability
 * (resolveDeliverableBridgeForSession), same shape as
 * crossSessionInject's bridge fallback. Bridges only paste-wrap
 * payloads that need it (newline or >200 chars — see
 * 09-bridge/src/bridge-payload.ts needsBracketedPaste); ESC ESC ships
 * unwrapped either way. Result 'bridge_esc' distinguishes this path
 * in the audit log from a direct PTY 'accepted'.
 *
 * Cooldown is enforced client-side per spec (1s lockout on the
 * button); the daemon side is fire-and-log so a second press during a
 * stuck inject still produces an audit row.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  IndexDb,
  PanicLogRow,
  ProjectSessionRow,
} from '../store/index-db.js';
import { resolvePanicTarget, type ResolveOptions } from './panic-target.js';
import { resolveDeliverableBridgeForSession } from './bridge-presence.js';

export const PANIC_PAYLOAD = '\x1b\x1b';

export interface PtyInjector {
  (
    ptyIdOrSession: string,
    text: string,
    commit: boolean,
  ): { ok: true } | { ok: false; error: string };
}

/** Bridge suggestion-queue writer. Shape matches
 * dashboard/sessions.js's queueSessionSuggestion; tests stub it so
 * the fallback path can be exercised without a live bridge dir. */
export interface BridgeSuggester {
  (
    sessionId: string,
    text: string,
  ): { ok: true; queued_at: string } | { ok: false; error: string };
}

/** Bridge deliverability check. Default reads live bridge-presence
 * state via resolveDeliverableBridgeForSession; tests stub it so the
 * fallback gate can be exercised without a real presence dir. */
export interface BridgeDeliverabilityCheck {
  (ccSessionId: string): {
    verdict: 'deliverable' | 'legacy-grace' | 'no_terminal' | 'not_claimed';
  };
}

export interface FireOptions extends ResolveOptions {
  caller: string;
  clickedMs: number;
  injector: PtyInjector;
  /** Bridge fallback (control-transport fix, 2026-07-14). Omitted =
   * legacy PTY-only behavior (existing callers / tests keep working
   * unchanged). When present, a PTY miss retries through the bridge
   * suggestion queue provided the target has a deliverable bridge. */
  bridgeSuggest?: BridgeSuggester;
  /** Defaults to resolveDeliverableBridgeForSession. Only consulted
   * when bridgeSuggest is set and the PTY attempt missed. */
  resolveDeliverableBridge?: BridgeDeliverabilityCheck;
}

export type PanicResult =
  | 'accepted'
  | 'pty_not_found'
  | 'no_target'
  | 'bridge_esc';

export interface FireResult {
  ok: boolean;
  result: PanicResult;
  target: ProjectSessionRow | null;
  log_id: string;
}

function writeLog(
  db: IndexDb,
  opts: {
    target: ProjectSessionRow | null;
    clickedMs: number;
    caller: string;
    result: PanicResult;
    ptyId: string | null;
  },
): string {
  const id = randomUUID();
  db.insertPanicLog({
    id,
    target_anchor_id: opts.target?.id ?? null,
    target_pty_id: opts.ptyId,
    target_session_id: opts.target?.current_session_id ?? null,
    clicked_ms: opts.clickedMs,
    caller: opts.caller,
    result: opts.result,
  });
  return id;
}

function fireOn(
  db: IndexDb,
  target: ProjectSessionRow | null,
  opts: FireOptions,
): FireResult {
  if (!target) {
    const logId = writeLog(db, {
      target: null,
      clickedMs: opts.clickedMs,
      caller: opts.caller,
      result: 'no_target',
      ptyId: null,
    });
    return { ok: false, result: 'no_target', target: null, log_id: logId };
  }
  /* Pick the injector key. Prefer the daemon-owned pty id snapshot on
   * the anchor; fall back to the bound CC session id when pty id is
   * null. Bridge-presence reconcile sets current_session_id on every
   * live tick but never populates current_pty_id, so the previous
   * "pty_id required" gate dropped every panic against a bridge-
   * attached anchor at the daemon door even when a daemon-owned PTY
   * was alive for that CC session. The production injector
   * (`ptyInject`) accepts either form: it tries `ptys.get(key)` first
   * and falls back to `getPtyBySession(key)` so an anchor whose
   * current_session_id maps to a live daemon PTY still receives the
   * \x1b\x1b interrupt. target_pty_id on the audit row stores the
   * exact key we tried so the dashboard can show whichever identifier
   * actually drove the inject. */
  const injectKey = target.current_pty_id ?? target.current_session_id ?? null;
  let ptyOk = false;
  if (injectKey) {
    const inj = opts.injector(injectKey, PANIC_PAYLOAD, false);
    ptyOk = inj.ok;
  }
  if (ptyOk) {
    const logId = writeLog(db, {
      target,
      clickedMs: opts.clickedMs,
      caller: opts.caller,
      result: 'accepted',
      ptyId: injectKey,
    });
    return { ok: true, result: 'accepted', target, log_id: logId };
  }
  /* PTY missed (or there was never a pty/session key to try). Bridge
   * fallback: only possible when the caller wired bridgeSuggest AND
   * the anchor has a bound CC session id (bridge presence keys on
   * that, not the daemon pty id). Bridge-attached anchors always have
   * current_session_id populated alongside current_bridge_id by
   * reconcileBridgePresence, so this is the same key injectKey would
   * have fallen back to. */
  const bridgeTarget = target.current_session_id;
  if (opts.bridgeSuggest && bridgeTarget) {
    const resolveDeliverable =
      opts.resolveDeliverableBridge ?? resolveDeliverableBridgeForSession;
    const deliverability = resolveDeliverable(bridgeTarget);
    if (
      deliverability.verdict === 'deliverable' ||
      deliverability.verdict === 'legacy-grace'
    ) {
      const bridgeResult = opts.bridgeSuggest(bridgeTarget, PANIC_PAYLOAD);
      if (bridgeResult.ok) {
        const logId = writeLog(db, {
          target,
          clickedMs: opts.clickedMs,
          caller: opts.caller,
          result: 'bridge_esc',
          ptyId: bridgeTarget,
        });
        return { ok: true, result: 'bridge_esc', target, log_id: logId };
      }
    }
  }
  const logId = writeLog(db, {
    target,
    clickedMs: opts.clickedMs,
    caller: opts.caller,
    result: 'pty_not_found',
    ptyId: injectKey,
  });
  return { ok: false, result: 'pty_not_found', target, log_id: logId };
}

/** Global panic: resolver picks the single target. */
export function firePanic(db: IndexDb, opts: FireOptions): FireResult {
  const resolved = resolvePanicTarget(db, opts);
  return fireOn(db, resolved.target, opts);
}

/** Anchor-pinned interrupt. Only fires when the pinned anchor is live;
 * dormant or unknown anchors return no_target so the audit log still
 * captures the attempt. */
export function fireProjectInterrupt(
  db: IndexDb,
  anchorId: string,
  opts: FireOptions,
): FireResult {
  const row = db.getProjectSession(anchorId);
  const target = row && row.status === 'live' ? row : null;
  return fireOn(db, target, opts);
}

export function recentPanics(db: IndexDb, limit: number = 20): PanicLogRow[] {
  return db.listRecentPanics(limit);
}

/** Injector deps for registerPanicRoutes (control-transport fix,
 * 2026-07-14). Mirrors the shape smart-compact-injector.ts /
 * crossSessionInject already use: a direct PTY transport plus a
 * bridge fallback gated on real deliverability. Passing only
 * `ptyInject` (legacy 3-arg call shape) keeps pure-PTY behavior for
 * any caller that hasn't been updated. */
export interface PanicInjectorDeps {
  ptyInject: PtyInjector;
  queueSessionSuggestion: BridgeSuggester;
  /** Defaults to resolveDeliverableBridgeForSession. */
  resolveDeliverableBridge?: BridgeDeliverabilityCheck;
}

export function registerPanicRoutes(
  app: FastifyInstance,
  db: IndexDb,
  deps: PtyInjector | PanicInjectorDeps,
  log: (msg: string) => void = () => undefined,
): void {
  /* Back-compat: a bare PtyInjector function (legacy call shape)
   * keeps PTY-only behavior with no bridge fallback wired. */
  const injectorDeps: PanicInjectorDeps =
    typeof deps === 'function' ? { ptyInject: deps, queueSessionSuggestion: () => ({ ok: false, error: 'bridge fallback not wired' }) } : deps;
  const injector = injectorDeps.ptyInject;
  const bridgeSuggest = injectorDeps.queueSessionSuggestion;
  const resolveDeliverableBridge = injectorDeps.resolveDeliverableBridge;
  app.post('/panic', async (req) => {
    const body = (req.body ?? {}) as {
      caller?: string;
      clicked_ms?: number;
    };
    const r = firePanic(db, {
      caller: typeof body.caller === 'string' ? body.caller : 'dashboard',
      clickedMs:
        typeof body.clicked_ms === 'number' ? body.clicked_ms : Date.now(),
      injector,
      bridgeSuggest,
      resolveDeliverableBridge,
    });
    log(
      `[panic] caller=${
        typeof body.caller === 'string' ? body.caller : 'dashboard'
      } result=${r.result} anchor=${r.target?.id ?? 'none'}`,
    );
    return {
      ok: r.ok,
      result: r.result,
      target_anchor_id: r.target?.id ?? null,
      log_id: r.log_id,
    };
  });

  app.post('/projects/:id/interrupt', async (req) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as {
      caller?: string;
      clicked_ms?: number;
    };
    const r = fireProjectInterrupt(db, id, {
      caller: typeof body.caller === 'string' ? body.caller : 'dashboard',
      clickedMs:
        typeof body.clicked_ms === 'number' ? body.clicked_ms : Date.now(),
      injector,
      bridgeSuggest,
      resolveDeliverableBridge,
    });
    log(
      `[panic] caller=${
        typeof body.caller === 'string' ? body.caller : 'dashboard'
      } result=${r.result} anchor=${id}`,
    );
    return {
      ok: r.ok,
      result: r.result,
      target_anchor_id: r.target?.id ?? null,
      log_id: r.log_id,
    };
  });

  app.get('/panic/recent', async (req) => {
    const q = (req.query ?? {}) as { limit?: string };
    const limit = q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 20;
    return { ok: true, panics: recentPanics(db, limit) };
  });
}
