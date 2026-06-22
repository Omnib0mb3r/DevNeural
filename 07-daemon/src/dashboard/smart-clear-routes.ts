/**
 * Smart-clear routes (DRIVE-QUEUE 4, spec 2b). The daemon's transport +
 * assembly + gate surface; Lex drives the decisioning loop.
 *
 *   GET  /lex/smart-clear/state?anchor_id=   ctx_pct + trigger verdict
 *                                            (idle | wind-down | force-stop)
 *                                            so Lex polls cheaply.
 *   GET  /lex/smart-clear/config             threshold / ceiling / mode.
 *   POST /lex/smart-clear/config             adjust them (no restart).
 *
 * The plan (investigator report + 2 artifacts + vet) and confirm (trail)
 * routes are added in a later piece. This module only wires the trigger.
 */
import type { FastifyInstance } from 'fastify';
import type { IndexDb } from '../store/index-db.js';
import { jsonlForAnchor } from './smart-compact-routes.js';
import {
  smartClearConfig,
  evaluateSmartClearTrigger,
  parseSmartClearMode,
  SMART_CLEAR_MODE_KEY,
  SMART_CLEAR_THRESHOLD_KEY,
  SMART_CLEAR_CEILING_KEY,
  DEFAULT_THRESHOLD_PCT,
  DEFAULT_CEILING_PCT,
} from '../lex/smart-clear.js';

export interface SmartClearRegisterOptions {
  ctxProvider?: (jsonlPath: string) => number | null;
}

export function registerSmartClearRoutes(
  app: FastifyInstance,
  db: IndexDb,
  log: (msg: string) => void = () => undefined,
  options: SmartClearRegisterOptions = {},
): void {
  app.get('/lex/smart-clear/state', async (req, reply) => {
    const q = (req.query ?? {}) as { anchor_id?: string };
    if (!q.anchor_id) {
      reply.code(400);
      return { ok: false, error: 'anchor_id required' };
    }
    const anchor = db.getProjectSession(q.anchor_id);
    if (!anchor) {
      reply.code(404);
      return { ok: false, error: 'anchor not found' };
    }
    const cfg = smartClearConfig(db);
    const jsonlPath = jsonlForAnchor(db, q.anchor_id);
    const ctxPct =
      jsonlPath && options.ctxProvider ? options.ctxProvider(jsonlPath) : null;
    const trigger = evaluateSmartClearTrigger({
      ctxPct,
      thresholdPct: cfg.thresholdPct,
      ceilingPct: cfg.ceilingPct,
    });
    return {
      ok: true,
      anchor_id: q.anchor_id,
      mode: cfg.mode,
      ctx_pct: ctxPct,
      threshold_pct: cfg.thresholdPct,
      ceiling_pct: cfg.ceilingPct,
      jsonl_path: jsonlPath,
      ...trigger,
    };
  });

  app.get('/lex/smart-clear/config', async () => {
    const cfg = smartClearConfig(db);
    return {
      ok: true,
      ...cfg,
      defaults: {
        thresholdPct: DEFAULT_THRESHOLD_PCT,
        ceilingPct: DEFAULT_CEILING_PCT,
      },
    };
  });

  app.post('/lex/smart-clear/config', async (req, reply) => {
    const body = (req.body ?? {}) as {
      mode?: string;
      threshold_pct?: number;
      ceiling_pct?: number;
      updated_by?: string;
    };
    let touched = false;
    if (body.mode !== undefined) {
      const m = parseSmartClearMode(body.mode);
      if (!m) {
        reply.code(400);
        return { ok: false, error: "mode must be 'off' | 'shadow' | 'live'" };
      }
      db.setRuntimeConfig(SMART_CLEAR_MODE_KEY, m, body.updated_by);
      touched = true;
    }
    if (typeof body.threshold_pct === 'number') {
      if (body.threshold_pct < 1 || body.threshold_pct > 99) {
        reply.code(400);
        return { ok: false, error: 'threshold_pct must be 1-99' };
      }
      db.setRuntimeConfig(
        SMART_CLEAR_THRESHOLD_KEY,
        String(Math.round(body.threshold_pct)),
        body.updated_by,
      );
      touched = true;
    }
    if (typeof body.ceiling_pct === 'number') {
      if (body.ceiling_pct < 1 || body.ceiling_pct > 99) {
        reply.code(400);
        return { ok: false, error: 'ceiling_pct must be 1-99' };
      }
      db.setRuntimeConfig(
        SMART_CLEAR_CEILING_KEY,
        String(Math.round(body.ceiling_pct)),
        body.updated_by,
      );
      touched = true;
    }
    if (!touched) {
      reply.code(400);
      return { ok: false, error: 'nothing to set (mode / threshold_pct / ceiling_pct)' };
    }
    const cfg = smartClearConfig(db);
    log(
      `[smart-clear] config -> mode=${cfg.mode} threshold=${cfg.thresholdPct} ceiling=${cfg.ceilingPct} by=${body.updated_by ?? 'unknown'}`,
    );
    return { ok: true, ...cfg };
  });
}
