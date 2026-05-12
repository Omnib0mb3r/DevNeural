/**
 * Panic button routes (PANIC-BUTTON.md steps 1, 3, 7).
 *
 * Three handler entry points:
 *   firePanic            -> POST /panic                  global single-target
 *   fireProjectInterrupt -> POST /projects/:id/interrupt anchor-pinned
 *   recentPanics         -> GET  /panic/recent           audit panel feed
 *
 * Every fire writes one panic_log row with result in
 * {accepted, pty_not_found, no_target}. The PTY transport is injected
 * so unit tests don't need a real PTY (production binds to ptyInject
 * from pty-host).
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

export const PANIC_PAYLOAD = '\x1b\x1b';

export interface PtyInjector {
  (
    ptyIdOrSession: string,
    text: string,
    commit: boolean,
  ): { ok: true } | { ok: false; error: string };
}

export interface FireOptions extends ResolveOptions {
  caller: string;
  clickedMs: number;
  injector: PtyInjector;
}

export type PanicResult = 'accepted' | 'pty_not_found' | 'no_target';

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
  const ptyId = target.current_pty_id;
  if (!ptyId) {
    const logId = writeLog(db, {
      target,
      clickedMs: opts.clickedMs,
      caller: opts.caller,
      result: 'pty_not_found',
      ptyId: null,
    });
    return { ok: false, result: 'pty_not_found', target, log_id: logId };
  }
  const inj = opts.injector(ptyId, PANIC_PAYLOAD, false);
  const result: PanicResult = inj.ok ? 'accepted' : 'pty_not_found';
  const logId = writeLog(db, {
    target,
    clickedMs: opts.clickedMs,
    caller: opts.caller,
    result,
    ptyId,
  });
  return { ok: inj.ok, result, target, log_id: logId };
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

export function registerPanicRoutes(
  app: FastifyInstance,
  db: IndexDb,
  injector: PtyInjector,
  log: (msg: string) => void = () => undefined,
): void {
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
