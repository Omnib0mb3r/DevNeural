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
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IndexDb } from '../store/index-db.js';
import { jsonlForAnchor } from './smart-compact-routes.js';
import {
  smartClearConfig,
  evaluateSmartClearTrigger,
  assembleSmartClearReport,
  vetReseed,
  confirmResumeOnTask,
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

  /* POST /lex/smart-clear/plan { anchor_id, cwd? }
   *
   * The investigator ASSEMBLES (spec 2b): one cohesive report from the
   * broad sweep + the two artifacts (safe stopping point, reseed draft) +
   * the vet verdict. NEVER injects - Lex reads this, vets/tightens the
   * reseed, then drives stop -> /clear -> /clear-and-paste (vetted reseed)
   * -> /confirm. Logs an audit row (the investigator's record of the
   * clear plan). cwd is resolved from the project_session / brainstorm so
   * the repo signals + project docs come from the worker's tree. */
  app.post('/lex/smart-clear/plan', async (req, reply) => {
    const body = (req.body ?? {}) as { anchor_id?: string; cwd?: string };
    if (!body.anchor_id) {
      reply.code(400);
      return { ok: false, error: 'anchor_id required' };
    }
    const ps = db.getProjectSession(body.anchor_id);
    let bsLabel: string | null = null;
    let bsCwd = '';
    try {
      const bsRow = db.getBrainstorm(body.anchor_id) as {
        user_label?: string | null;
        derived_label?: string | null;
        cwd?: string;
      } | null;
      if (bsRow) {
        bsLabel = bsRow.user_label ?? bsRow.derived_label ?? null;
        bsCwd = bsRow.cwd ?? '';
      }
    } catch {
      /* brainstorm not resolvable; report degrades to repo-signal only */
    }
    const cwd = (body.cwd ?? ps?.cwd ?? bsCwd ?? '').replace(/\\/g, '/');
    const label = bsLabel ?? ps?.title ?? null;
    /* Worker anchors (project_session ids) have no brainstorm row, so
     * the investigator sweep inside assembleSmartClearReport fails
     * closed for them; the worker's live jsonl tail is their
     * active-work source (2026-07-16 content-empty draft fix). */
    const workerJsonlPath = jsonlForAnchor(db, body.anchor_id);
    const report = assembleSmartClearReport({
      db,
      anchorId: body.anchor_id,
      cwd,
      label,
      workerJsonlPath,
    });
    const vet = vetReseed(report.reseed);
    const cfg = smartClearConfig(db);
    try {
      db.insertSmartCompactLog({
        id: randomUUID(),
        anchor_id: body.anchor_id,
        cc_session_id: ps?.current_session_id ?? null,
        caller: 'smart-clear',
        reason: 'ctx-fill-plan',
        action: 'noop',
        pre_ctx_pct: null,
        summary_preview: report.stoppingPoint.slice(0, 280),
        payload_text: report.reseed,
      });
    } catch {
      /* audit is best-effort; never block the plan response */
    }
    log(
      `[smart-clear] plan anchor=${body.anchor_id.slice(0, 8)} mode=${cfg.mode} has_content=${report.hasContent} vet_ok=${vet.ok} dirty=${report.signals.dirty}`,
    );
    return {
      ok: true,
      anchor_id: body.anchor_id,
      mode: cfg.mode,
      has_content: report.hasContent,
      report: report.report,
      stopping_point: report.stoppingPoint,
      reseed: report.reseed,
      vet,
      signals: report.signals,
    };
  });

  /* POST /lex/smart-clear/confirm { anchor_id?, new_jsonl, reseed }
   *
   * Trail-confirm (spec 2b step 6): after Lex injects the vetted reseed,
   * it trails the worker's NEW jsonl (found by mtime) to confirm the
   * worker actually resumed on task. Logs the outcome (the investigator's
   * audit record of the clear closing out). */
  app.post('/lex/smart-clear/confirm', async (req, reply) => {
    const body = (req.body ?? {}) as {
      anchor_id?: string;
      new_jsonl?: string;
      reseed?: string;
    };
    if (!body.new_jsonl || !body.reseed) {
      reply.code(400);
      return { ok: false, error: 'new_jsonl and reseed required' };
    }
    const result = confirmResumeOnTask({
      newJsonl: body.new_jsonl,
      reseed: body.reseed,
    });
    if (body.anchor_id) {
      const ps = db.getProjectSession(body.anchor_id);
      try {
        db.insertSmartCompactLog({
          id: randomUUID(),
          anchor_id: body.anchor_id,
          cc_session_id: ps?.current_session_id ?? null,
          caller: 'smart-clear',
          reason: result.onTask ? 'ctx-fill-confirm-ok' : 'ctx-fill-confirm-fail',
          action: 'noop',
          pre_ctx_pct: null,
          summary_preview: result.reason.slice(0, 280),
        });
      } catch {
        /* audit best-effort */
      }
    }
    log(
      `[smart-clear] confirm on_task=${result.onTask} echo=${result.sawReseedEcho} assistant=${result.sawAssistant}`,
    );
    return { ok: true, ...result };
  });
}
