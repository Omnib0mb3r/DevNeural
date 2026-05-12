/**
 * Smart compact routes (SMART-COMPACT.md "Mechanics" + "Audit").
 *
 *   POST /lex/smart-compact/evaluate    {anchor_id}
 *     -> {action, reason, ctx_pct, summary?, shadow}
 *
 *   POST /lex/smart-compact/fire        {anchor_id, reason, caller?, summary?}
 *     -> writes audit row; if not shadow and the anchor has a current
 *        PTY, injects /clear then the summary; if action='wrap' injects
 *        the wrap-and-commit prompt instead.
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
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { IndexDb, SmartCompactLogRow } from '../store/index-db.js';
import {
  assembleSummary,
  defaults,
  evaluateTrigger,
  isShadow,
  WRAP_AND_COMMIT_PROMPT,
  type EvalAction,
  type EvalReason,
  type Phase,
} from '../lex/smart-compact.js';

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
  summary?: string;
  jsonl_path: string | null;
  anchor_id: string;
}

function jsonlForAnchor(db: IndexDb, anchorId: string): string | null {
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

function recentCommits(cwd: string, n: number = 10): string[] {
  if (!cwd || !fs.existsSync(cwd)) return [];
  try {
    const out = execFileSync(
      'git',
      ['-C', cwd, 'log', `-${n}`, '--oneline'],
      { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function diffStat(cwd: string): string {
  if (!cwd || !fs.existsSync(cwd)) return '';
  try {
    const out = execFileSync(
      'git',
      ['-C', cwd, 'diff', '--stat'],
      { encoding: 'utf-8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    /* Last line of --stat is the summary, e.g.
     * " 3 files changed, 42 insertions(+), 5 deletions(-)". */
    const lines = out.split('\n').filter((l) => l.trim());
    return lines[lines.length - 1] ?? '';
  } catch {
    return '';
  }
}

function jsonlTailSummary(jsonlPath: string | null): string {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return '';
  try {
    const stat = fs.statSync(jsonlPath);
    const tailLen = Math.min(stat.size, 8 * 1024);
    const start = stat.size - tailLen;
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(tailLen);
      fs.readSync(fd, buf, 0, tailLen, start);
      const text = buf.toString('utf-8');
      const lines = text.split('\n').filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(lines[i]!) as {
            type?: string;
            message?: { content?: unknown };
          };
          if (rec.type === 'assistant' || rec.type === 'user') {
            const content =
              typeof rec.message?.content === 'string'
                ? rec.message.content
                : JSON.stringify(rec.message?.content ?? '');
            return content.slice(0, 240);
          }
        } catch {
          continue;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore */
  }
  return '';
}

export interface BuildSummaryOptions {
  recentCommits?: (cwd: string) => string[];
  diffStat?: (cwd: string) => string;
  lastActionSummary?: (jsonlPath: string | null) => string;
}

export function buildAnchorSummary(
  db: IndexDb,
  anchorId: string,
  opts: BuildSummaryOptions = {},
): { summary: string; jsonlPath: string | null } | null {
  const anchor = db.getProjectSession(anchorId);
  if (!anchor) return null;
  const jsonlPath = jsonlForAnchor(db, anchorId);
  const commits = (opts.recentCommits ?? recentCommits)(anchor.cwd);
  const diff = (opts.diffStat ?? diffStat)(anchor.cwd);
  const lastAction = (opts.lastActionSummary ?? jsonlTailSummary)(jsonlPath);
  const findings = (() => {
    try {
      return db.listAuditFindings({
        status: 'open',
        limit: 50,
      }).length;
    } catch {
      return 0;
    }
  })();
  const activeWork = pickActiveWork(anchor.cwd);
  return {
    jsonlPath,
    summary: assembleSummary({
      projectSlug: anchor.project_slug,
      title: anchor.title,
      cwd: anchor.cwd,
      activeWork,
      recentCommits: commits,
      diffStat: diff,
      jsonlPath: jsonlPath ?? '',
      lastActionSummary: lastAction,
      openAuditFindings: findings,
    }),
  };
}

function pickActiveWork(cwd: string): string {
  /* Best-effort: read first heading of TODO.md if present, else the
   * one-line summary from docs/spec/ROADMAP-or-first-spec. Falls back
   * to a generic line. */
  const todo = path.posix.join(cwd.replace(/\\/g, '/'), 'TODO.md');
  if (fs.existsSync(todo)) {
    try {
      const head = fs
        .readFileSync(todo, 'utf-8')
        .split('\n')
        .find((l) => l.trim() && !l.trim().startsWith('#'));
      if (head) return head.trim().slice(0, 240);
    } catch {
      /* fall through */
    }
  }
  return 'see TODO.md / docs/spec for current focus';
}

export function evaluateSmartCompact(
  db: IndexDb,
  anchorId: string,
  opts: EvaluateOptions = {},
): EvaluateResult {
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
  let summary: string | undefined;
  if (verdict.action === 'fire' || verdict.action === 'wrap') {
    const built = buildAnchorSummary(db, anchorId);
    summary = built?.summary;
  }
  return {
    ok: true,
    action: verdict.action,
    reason: verdict.reason,
    ctx_pct: ctxPct,
    shadow,
    summary,
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
}

export interface FireResult {
  ok: boolean;
  action: EvalAction | 'shadow';
  shadow: boolean;
  log_id: string;
  inject_result?: 'accepted' | 'pty_not_found' | 'wrap-injected';
  anchor_id: string;
}

export function fireSmartCompact(
  db: IndexDb,
  anchorId: string,
  opts: FireOptions,
): FireResult {
  const anchor = db.getProjectSession(anchorId);
  const shadow = !opts.force && isShadow(db, anchorId);

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
    });
    return {
      ok: true,
      action: 'shadow',
      shadow: true,
      log_id: logId,
      anchor_id: anchorId,
    };
  }

  const ptyId = anchor?.current_pty_id ?? null;
  let injectResult: FireResult['inject_result'] = 'pty_not_found';
  if (ptyId) {
    if (opts.action === 'wrap') {
      const r = opts.injector(ptyId, WRAP_AND_COMMIT_PROMPT, true);
      injectResult = r.ok ? 'wrap-injected' : 'pty_not_found';
    } else {
      /* fire: /clear then summary. Two injects with the existing 80ms
       * paste-then-Enter delay built into ptyInject. */
      const cleared = opts.injector(ptyId, '/clear', true);
      const summary = opts.summary ?? '';
      const ship = opts.injector(ptyId, summary, true);
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
    const r = evaluateSmartCompact(db, body.anchor_id, {
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
    const r = fireSmartCompact(db, body.anchor_id, {
      caller: body.caller ?? 'lex',
      reason: body.reason,
      action: body.action,
      ctxPct: typeof body.ctx_pct === 'number' ? body.ctx_pct : null,
      summary: body.summary,
      injector,
      force: body.force === true,
    });
    log(
      `[smart-compact] anchor=${body.anchor_id} reason=${body.reason} action=${r.action} shadow=${r.shadow}`,
    );
    return r;
  });

  app.get('/lex/smart-compact/recent', async (req) => {
    const q = (req.query ?? {}) as { limit?: string };
    const limit = q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : 20;
    return { ok: true, rows: recentSmartCompacts(db, limit) };
  });
}
