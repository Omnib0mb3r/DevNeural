/**
 * Smart-compact route handlers.
 *
 * Exercises evaluateSmartCompact + fireSmartCompact + recentSmartCompacts
 * against a tmp DB seeded with project_session rows. PTY transport is
 * injected as a vi.fn() so we can assert /clear + summary deliver and
 * shadow gating skips inject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  clearAndPaste,
  fireSmartCompact,
  parseSmartCompactPolicyOwner,
  parseSmartCompactValue,
  readSmartCompactState,
  recentSmartCompacts,
  registerSmartCompactRoutes,
  smartCompactMode,
  smartCompactPolicyOwner,
  wrapPaste,
  SMART_COMPACT_CONFIG_KEY,
  SMART_COMPACT_POLICY_OWNER_KEY,
} from '../src/dashboard/smart-compact-routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let priors: {
  DEVNEURAL_DATA_ROOT?: string;
  DEVNEURAL_PROJECTS_ROOT?: string;
  USERPROFILE?: string;
  HOME?: string;
  DEVNEURAL_SMART_COMPACT_SHADOW_N?: string;
  DEVNEURAL_SMART_COMPACT_ENABLED?: string;
};

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-smart-routes-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  priors = {
    DEVNEURAL_DATA_ROOT: process.env.DEVNEURAL_DATA_ROOT,
    DEVNEURAL_PROJECTS_ROOT: process.env.DEVNEURAL_PROJECTS_ROOT,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    DEVNEURAL_SMART_COMPACT_SHADOW_N:
      process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N,
    DEVNEURAL_SMART_COMPACT_ENABLED:
      process.env.DEVNEURAL_SMART_COMPACT_ENABLED,
  };
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'Projects');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  /* Set shadow gate to 0 + global toggle ON so tests can drive live
   * behavior. The shadow-specific test and the global-toggle test
   * set these back as needed. */
  process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N = '0';
  process.env.DEVNEURAL_SMART_COMPACT_ENABLED = 'true';

  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } })
    .db.prepare('DELETE FROM project_session')
    .run();
});

afterEach(() => {
  db.close();
  for (const [k, v] of Object.entries(priors)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedAnchor(opts: {
  id: string;
  cwd?: string;
  pty?: string | null;
  cc?: string | null;
}): void {
  db.insertProjectSession({
    id: opts.id,
    project_slug: opts.id,
    cwd: opts.cwd ?? `C:/p/${opts.id}`,
    title: opts.id,
    status: 'live',
    current_session_id:
      opts.cc === undefined ? 'cc-' + opts.id : opts.cc,
    current_bridge_id: 'b-' + opts.id,
    current_pty_id:
      opts.pty === undefined ? 'pty-' + opts.id : opts.pty,
    created_ms: 1,
    last_seen_ms: 1,
  });
}

describe('fireSmartCompact', () => {
  it('injects /clear and the summary when not in shadow and pty is bound', () => {
    seedAnchor({ id: 'a', pty: 'pty-A', cc: 'cc-A' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = fireSmartCompact(db, 'a', {
      caller: 'lex',
      reason: 'window-open',
      action: 'fire',
      ctxPct: 60,
      summary: 'resume here',
      injector,
    });
    expect(r.action).toBe('fire');
    expect(r.shadow).toBe(false);
    expect(r.inject_result).toBe('accepted');
    expect(injector).toHaveBeenNthCalledWith(1, 'pty-A', '/clear', true);
    expect(injector).toHaveBeenNthCalledWith(2, 'pty-A', 'resume here', true);
    expect(recentSmartCompacts(db)[0]!.action).toBe('fire');
  });

  it('injects only the wrap-and-commit prompt when action=wrap', () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = fireSmartCompact(db, 'a', {
      caller: 'lex',
      reason: 'forced-no-stop',
      action: 'wrap',
      ctxPct: 75,
      injector,
    });
    expect(r.action).toBe('wrap');
    expect(injector).toHaveBeenCalledTimes(1);
    const [, text] = injector.mock.calls[0]!;
    expect(text).toMatch(/Wrap your current work/);
    expect(recentSmartCompacts(db)[0]!.action).toBe('wrap');
  });

  it('records inject_result=pty_not_found only when anchor has no pty_id AND no session_id', () => {
    /* Both missing → no resolvable target. Bridge fallback can't be
     * tried either since queueSessionPrompt needs a session id. */
    seedAnchor({ id: 'a', pty: null, cc: null });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = fireSmartCompact(db, 'a', {
      caller: 'lex',
      reason: 'window-open',
      action: 'fire',
      ctxPct: 60,
      summary: 'resume here',
      injector,
    });
    expect(r.ok).toBe(false);
    expect(r.inject_result).toBe('pty_not_found');
    expect(injector).not.toHaveBeenCalled();
  });

  it('falls back to current_session_id when current_pty_id is null (bridge-bound anchor)', () => {
    /* The route-level injector wired in registerSmartCompactRoutes
     * resolves the target string against listPtys first, then bridge
     * queueSessionPrompt. fireSmartCompact itself just needs to hand
     * SOME identifier; it should prefer pty_id, then session_id. */
    seedAnchor({ id: 'a', pty: null, cc: 'cc-A' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = fireSmartCompact(db, 'a', {
      caller: 'lex',
      reason: 'window-open',
      action: 'fire',
      ctxPct: 60,
      summary: 'resume here',
      injector,
    });
    expect(r.ok).toBe(true);
    expect(r.inject_result).toBe('accepted');
    expect(injector).toHaveBeenNthCalledWith(1, 'cc-A', '/clear', true);
    expect(injector).toHaveBeenNthCalledWith(2, 'cc-A', 'resume here', true);
  });

  it('persists payload_text on the audit row (full summary, not just preview)', () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const longSummary = 'You were working on demo. '.repeat(40);
    const r = fireSmartCompact(db, 'a', {
      caller: 'lex',
      reason: 'window-open',
      action: 'fire',
      ctxPct: 60,
      summary: longSummary,
      injector: vi.fn(() => ({ ok: true as const })),
    });
    expect(r.action).toBe('fire');
    const row = recentSmartCompacts(db)[0]!;
    expect(row.payload_text).toBe(longSummary);
    expect(row.summary_preview?.length).toBeLessThanOrEqual(280);
  });

  it('global toggle DEVNEURAL_SMART_COMPACT_ENABLED unset/false degrades fire to shadow (no inject)', () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const prior = process.env.DEVNEURAL_SMART_COMPACT_ENABLED;
    /* Default-off: explicitly unset to confirm the kill-switch is
     * the default at launch (shadow-only until operator opts in).
     * Stage 3 removed the per-anchor isShadow gate so the global
     * mode='shadow' kill-switch is the only safety net left. */
    delete process.env.DEVNEURAL_SMART_COMPACT_ENABLED;
    try {
      const injector = vi.fn(() => ({ ok: true as const }));
      const r = fireSmartCompact(db, 'a', {
        caller: 'lex',
        reason: 'window-open',
        action: 'fire',
        ctxPct: 60,
        summary: 'queued payload',
        injector,
      });
      expect(r.action).toBe('shadow');
      expect(r.shadow).toBe(true);
      expect(injector).not.toHaveBeenCalled();
      const row = recentSmartCompacts(db)[0]!;
      expect(row.action).toBe('shadow');
      expect(row.payload_text).toBe('queued payload');
    } finally {
      if (prior === undefined)
        delete process.env.DEVNEURAL_SMART_COMPACT_ENABLED;
      else process.env.DEVNEURAL_SMART_COMPACT_ENABLED = prior;
    }
  });

  it('wrap action persists WRAP_AND_COMMIT_PROMPT as payload_text', () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const r = fireSmartCompact(db, 'a', {
      caller: 'lex',
      reason: 'forced-no-stop',
      action: 'wrap',
      ctxPct: 75,
      injector: vi.fn(() => ({ ok: true as const })),
    });
    expect(r.action).toBe('wrap');
    expect(recentSmartCompacts(db)[0]!.payload_text).toMatch(
      /Wrap your current work/,
    );
  });
});

describe('smart-compact three-state runtime toggle', () => {
  it('parseSmartCompactValue maps legacy + canonical spellings', () => {
    expect(parseSmartCompactValue('off')).toBe('off');
    expect(parseSmartCompactValue('false')).toBe('off');
    expect(parseSmartCompactValue('0')).toBe('off');
    expect(parseSmartCompactValue('shadow')).toBe('shadow');
    expect(parseSmartCompactValue('live')).toBe('live');
    expect(parseSmartCompactValue('on')).toBe('live');
    expect(parseSmartCompactValue('true')).toBe('live');
    expect(parseSmartCompactValue('1')).toBe('live');
    expect(parseSmartCompactValue('')).toBeNull();
    expect(parseSmartCompactValue('garbage')).toBeNull();
    expect(parseSmartCompactValue(undefined)).toBeNull();
    expect(parseSmartCompactValue(null)).toBeNull();
  });

  it('resolution order: runtime_config wins over env; env fills in when runtime is unset', () => {
    /* Top of the file already sets env=true so smartCompactMode
     * returns 'live' before any runtime_config write. */
    expect(smartCompactMode(db)).toBe('live');
    /* runtime override flips it. */
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'shadow', 'test');
    expect(smartCompactMode(db)).toBe('shadow');
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'off', 'test');
    expect(smartCompactMode(db)).toBe('off');
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'live', 'test');
    expect(smartCompactMode(db)).toBe('live');
  });

  it('default falls through to shadow when both runtime and env are unset', () => {
    const prior = process.env.DEVNEURAL_SMART_COMPACT_ENABLED;
    delete process.env.DEVNEURAL_SMART_COMPACT_ENABLED;
    try {
      /* runtime_config is empty in this fresh DB. */
      expect(smartCompactMode(db)).toBe('shadow');
    } finally {
      if (prior === undefined)
        delete process.env.DEVNEURAL_SMART_COMPACT_ENABLED;
      else process.env.DEVNEURAL_SMART_COMPACT_ENABLED = prior;
    }
  });

  it("mode='off' short-circuits fire to noop without writing a log row", () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'off', 'test');
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = fireSmartCompact(db, 'a', {
      caller: 'lex',
      reason: 'window-open',
      action: 'fire',
      ctxPct: 60,
      summary: 'dropped silently',
      injector,
      /* force=true MUST NOT override off — off is supposed to be
       * inert. */
      force: true,
    });
    expect(r.action).toBe('shadow');
    expect(r.log_id).toBe('');
    expect(injector).not.toHaveBeenCalled();
    /* No log row was inserted. */
    expect(recentSmartCompacts(db).length).toBe(0);
  });

  it("mode='shadow' logs a shadow row + skips inject even with force", () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'shadow', 'test');
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = fireSmartCompact(db, 'a', {
      caller: 'lex',
      reason: 'window-open',
      action: 'fire',
      ctxPct: 60,
      summary: 'pending payload',
      injector,
      force: true,
    });
    expect(r.action).toBe('shadow');
    expect(injector).not.toHaveBeenCalled();
    const row = recentSmartCompacts(db)[0]!;
    expect(row.action).toBe('shadow');
    expect(row.payload_text).toBe('pending payload');
  });

  it("mode='live' injects and logs fire when the per-anchor shadow gate is cleared", () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'live', 'test');
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = fireSmartCompact(db, 'a', {
      caller: 'lex',
      reason: 'window-open',
      action: 'fire',
      ctxPct: 60,
      summary: 'real payload',
      injector,
    });
    expect(r.action).toBe('fire');
    /* /clear + summary injects on the resolved pty. */
    expect(injector).toHaveBeenCalled();
  });
});

describe('POST /lex/smart-compact/fire validation (v2 - Lex-authored summary)', () => {
  async function buildApp(): Promise<{
    app: ReturnType<typeof Fastify>;
    injector: ReturnType<typeof vi.fn>;
  }> {
    const app = Fastify({ logger: false });
    const injector = vi.fn(() => ({ ok: true as const }));
    registerSmartCompactRoutes(app, db, injector, () => undefined);
    await app.ready();
    return { app, injector };
  }

  it("rejects fire with 400 when summary is missing (action='fire')", async () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/fire',
        payload: {
          anchor_id: 'a',
          reason: 'window-open',
          action: 'fire',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/summary is required/i);
      expect(injector).not.toHaveBeenCalled();
      /* No audit row written when the route short-circuits. */
      expect(recentSmartCompacts(db).length).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects fire when summary is whitespace-only', async () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/fire',
        payload: {
          anchor_id: 'a',
          reason: 'window-open',
          action: 'fire',
          summary: '   \n  \t  ',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(injector).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("accepts fire when summary is a non-empty string (action='fire')", async () => {
    /* cwd left empty so the route's awaitSessionReady gate is skipped
     * and fireSmartCompact runs the legacy back-to-back inline path
     * (/clear + summary synchronously). The event-driven async path
     * is exercised in smart-compact-parked-replay.test.ts. */
    seedAnchor({ id: 'a', cwd: '', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/fire',
        payload: {
          anchor_id: 'a',
          reason: 'window-open',
          action: 'fire',
          summary: 'Lex-authored resume prompt here.',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; action: string };
      expect(body.action).toBe('fire');
      /* injector receives /clear, then the summary string verbatim. */
      const calls = injector.mock.calls.map((c) => c[1]);
      expect(calls[0]).toBe('/clear');
      expect(calls).toContain('Lex-authored resume prompt here.');
    } finally {
      await app.close();
    }
  });

  it("does NOT require summary when action='wrap' (daemon-authored prompt)", async () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/fire',
        payload: {
          anchor_id: 'a',
          reason: 'forced-no-stop',
          action: 'wrap',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { action: string };
      expect(body.action).toBe('wrap');
      const calls = injector.mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0]![1]).toMatch(/Wrap your current work/);
    } finally {
      await app.close();
    }
  });
});

/* Fix 41 Stage 1 — policy-out endpoints. Each describe block pins one
 * of the three new surfaces: /state (read-only inputs), /clear-and-paste
 * (Lex-authored summary), /wrap-paste (Lex-authored wrap). Coverage
 * matrix: happy path, 400 (missing field), 404 (anchor unknown),
 * audit-row-shape pin where applicable. */

describe('readSmartCompactState (Fix 41 Stage 1)', () => {
  it('returns ok=false + error when anchor is unknown', () => {
    const r = readSmartCompactState(db, 'missing');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('anchor not found');
  });

  it('returns null ctx_pct + null last_*_ms + shadow_count=0 for a bare anchor', () => {
    seedAnchor({ id: 'a', cwd: '' });
    const r = readSmartCompactState(db, 'a');
    expect(r.ok).toBe(true);
    expect(r.anchor_id).toBe('a');
    expect(r.ctx_pct).toBeNull();
    expect(r.last_commit_ms).toBeNull();
    expect(r.last_tool_ms).toBeNull();
    expect(r.jsonl_path).toBeNull();
    expect(r.shadow_count).toBe(0);
    expect(r.mode).toBe('live');
  });

  it('uses ctxProvider when jsonl_path is resolvable', () => {
    seedAnchor({ id: 'a' });
    db.insertProjectTranscriptRef({
      id: `ref-a-${Math.random().toString(36).slice(2, 8)}`,
      anchor_id: 'a',
      jsonl_path: 'C:/tmp/anchor-a.jsonl',
      cc_session_id: 'cc-a',
      opened_ms: 1,
      closed_ms: null,
    });
    const ctxProvider = vi.fn(() => 42.5);
    const r = readSmartCompactState(db, 'a', { ctxProvider });
    expect(r.ctx_pct).toBe(42.5);
    expect(r.jsonl_path).toBe('C:/tmp/anchor-a.jsonl');
    expect(ctxProvider).toHaveBeenCalledWith('C:/tmp/anchor-a.jsonl');
  });

  it('reflects shadow_count from existing smart_compact_log rows', () => {
    seedAnchor({ id: 'a' });
    db.insertSmartCompactLog({
      id: 'sc1',
      anchor_id: 'a',
      cc_session_id: 'cc-a',
      caller: 'lex',
      reason: 'window-open',
      action: 'shadow',
      pre_ctx_pct: 60,
    });
    db.insertSmartCompactLog({
      id: 'sc2',
      anchor_id: 'a',
      cc_session_id: 'cc-a',
      caller: 'lex',
      reason: 'window-open',
      action: 'fire',
      pre_ctx_pct: 60,
    });
    const r = readSmartCompactState(db, 'a');
    expect(r.shadow_count).toBe(2);
  });

  it('reflects current smartCompactMode (off / shadow / live)', () => {
    seedAnchor({ id: 'a' });
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'off', 'test');
    expect(readSmartCompactState(db, 'a').mode).toBe('off');
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'shadow', 'test');
    expect(readSmartCompactState(db, 'a').mode).toBe('shadow');
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'live', 'test');
    expect(readSmartCompactState(db, 'a').mode).toBe('live');
  });
});

describe('GET /lex/smart-compact/state (Fix 41 Stage 1)', () => {
  async function buildApp(opts?: {
    ctxProvider?: (jsonl: string) => number | null;
  }): Promise<{
    app: ReturnType<typeof Fastify>;
    injector: ReturnType<typeof vi.fn>;
  }> {
    const app = Fastify({ logger: false });
    const injector = vi.fn(() => ({ ok: true as const }));
    registerSmartCompactRoutes(
      app,
      db,
      injector,
      () => undefined,
      opts?.ctxProvider ? { ctxProvider: opts.ctxProvider } : {},
    );
    await app.ready();
    return { app, injector };
  }

  it('rejects with 400 when anchor_id is missing', async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/lex/smart-compact/state',
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/anchor_id required/i);
    } finally {
      await app.close();
    }
  });

  it('returns 404 when the anchor is unknown', async () => {
    const { app } = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/lex/smart-compact/state?anchor_id=ghost',
      });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe('anchor not found');
    } finally {
      await app.close();
    }
  });

  it('happy path: returns the consolidated state shape via the ctxProvider', async () => {
    seedAnchor({ id: 'a', cwd: '' });
    db.insertProjectTranscriptRef({
      id: `ref-a-${Math.random().toString(36).slice(2, 8)}`,
      anchor_id: 'a',
      jsonl_path: 'C:/tmp/anchor-a.jsonl',
      cc_session_id: 'cc-a',
      opened_ms: 1,
      closed_ms: null,
    });
    const ctxProvider = vi.fn(() => 71.2);
    const { app } = await buildApp({ ctxProvider });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/lex/smart-compact/state?anchor_id=a',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ok: boolean;
        ctx_pct: number;
        jsonl_path: string;
        shadow_count: number;
        mode: string;
      };
      expect(body.ok).toBe(true);
      expect(body.ctx_pct).toBe(71.2);
      expect(body.jsonl_path).toBe('C:/tmp/anchor-a.jsonl');
      expect(body.shadow_count).toBe(0);
      expect(body.mode).toBe('live');
    } finally {
      await app.close();
    }
  });
});

describe('clearAndPaste (Fix 41 Stage 1)', () => {
  it('rejects when summary is empty', () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = clearAndPaste(db, 'a', {
      reason: 'window-open',
      summary: '   ',
      injector,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/summary is required/i);
    expect(injector).not.toHaveBeenCalled();
    expect(recentSmartCompacts(db).length).toBe(0);
  });

  it('rejects when anchor is unknown', () => {
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = clearAndPaste(db, 'ghost', {
      reason: 'window-open',
      summary: 'resume here',
      injector,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('anchor not found');
    expect(injector).not.toHaveBeenCalled();
  });

  it("returns noop when mode='off' (no audit row, no inject)", () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'off', 'test');
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = clearAndPaste(db, 'a', {
      reason: 'window-open',
      summary: 'resume here',
      injector,
    });
    expect(r.ok).toBe(true);
    expect(r.inject_result).toBe('noop');
    expect(r.log_id).toBe('');
    expect(injector).not.toHaveBeenCalled();
    expect(recentSmartCompacts(db).length).toBe(0);
  });

  it('happy path: injects /clear + summary back-to-back and writes audit row action=clear-and-paste', () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = clearAndPaste(db, 'a', {
      reason: 'window-open',
      summary: 'Lex-authored resume.',
      preCtxPct: 62,
      injector,
    });
    expect(r.ok).toBe(true);
    expect(r.inject_result).toBe('accepted');
    expect(injector).toHaveBeenNthCalledWith(1, 'pty-A', '/clear', true);
    expect(injector).toHaveBeenNthCalledWith(
      2,
      'pty-A',
      'Lex-authored resume.',
      true,
    );
    const row = recentSmartCompacts(db)[0]!;
    expect(row.action).toBe('clear-and-paste');
    expect(row.payload_text).toBe('Lex-authored resume.');
    expect(row.pre_ctx_pct).toBe(62);
    expect(row.caller).toBe('lex');
  });

  it('uses readiness gate when awaitSessionReady is supplied', async () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const awaitSessionReady = vi.fn(async () => ({
      ready: true as const,
      reason: 'ready' as const,
      elapsed_ms: 10,
      new_jsonl: 'C:/tmp/new.jsonl',
    }));
    const onResumeComplete = vi.fn();
    const r = clearAndPaste(db, 'a', {
      reason: 'window-open',
      summary: 'resume',
      injector,
      awaitSessionReady,
      onResumeComplete,
    });
    expect(r.inject_result).toBe('accepted-pending-ready');
    /* /clear inject happens synchronously; summary paste runs in the
     * background after the gate resolves. */
    expect(injector).toHaveBeenCalledTimes(1);
    expect(injector).toHaveBeenCalledWith('pty-A', '/clear', true);
    /* Give the async sequence a tick to drain. */
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(awaitSessionReady).toHaveBeenCalledTimes(1);
    expect(injector).toHaveBeenCalledTimes(2);
    expect(injector).toHaveBeenNthCalledWith(2, 'pty-A', 'resume', true);
    expect(onResumeComplete).toHaveBeenCalledWith({
      ship_ok: true,
      wait: expect.objectContaining({ ready: true }),
    });
  });
});

describe('POST /lex/smart-compact/clear-and-paste (Fix 41 Stage 1)', () => {
  async function buildApp(): Promise<{
    app: ReturnType<typeof Fastify>;
    injector: ReturnType<typeof vi.fn>;
  }> {
    const app = Fastify({ logger: false });
    const injector = vi.fn(() => ({ ok: true as const }));
    registerSmartCompactRoutes(app, db, injector, () => undefined);
    await app.ready();
    return { app, injector };
  }

  it('400 when summary missing', async () => {
    seedAnchor({ id: 'a', cwd: '', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/clear-and-paste',
        payload: { anchor_id: 'a', reason: 'window-open' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { ok: boolean; error: string };
      expect(body.error).toMatch(/summary is required/i);
      expect(injector).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('400 when summary is whitespace-only', async () => {
    seedAnchor({ id: 'a', cwd: '', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/clear-and-paste',
        payload: {
          anchor_id: 'a',
          reason: 'window-open',
          summary: '   \n\t  ',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(injector).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('400 when reason missing', async () => {
    seedAnchor({ id: 'a', cwd: '', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/clear-and-paste',
        payload: { anchor_id: 'a', summary: 'resume here' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/reason required/i);
      expect(injector).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('404 when anchor unknown', async () => {
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/clear-and-paste',
        payload: {
          anchor_id: 'ghost',
          reason: 'window-open',
          summary: 'resume here',
        },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { error: string };
      expect(body.error).toBe('anchor not found');
      expect(injector).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('happy path: 200 + injector called twice + audit row action=clear-and-paste', async () => {
    /* cwd='' skips the readiness gate and uses the synchronous
     * back-to-back inject path; identical to the existing /fire happy
     * path's setup. */
    seedAnchor({ id: 'a', cwd: '', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/clear-and-paste',
        payload: {
          anchor_id: 'a',
          reason: 'window-open',
          summary: 'Lex-authored resume.',
          pre_ctx_pct: 63,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; inject_result: string };
      expect(body.ok).toBe(true);
      expect(body.inject_result).toBe('accepted');
      expect(injector).toHaveBeenCalledTimes(2);
      const row = recentSmartCompacts(db)[0]!;
      expect(row.action).toBe('clear-and-paste');
      expect(row.payload_text).toBe('Lex-authored resume.');
      expect(row.pre_ctx_pct).toBe(63);
    } finally {
      await app.close();
    }
  });

  it('use_readiness_gate=false forces the synchronous back-to-back path even when cwd is present', async () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/clear-and-paste',
        payload: {
          anchor_id: 'a',
          reason: 'window-open',
          summary: 'resume here',
          use_readiness_gate: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { inject_result: string };
      /* No accepted-pending-ready; the gate was skipped. */
      expect(body.inject_result).toBe('accepted');
      expect(injector).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

describe('smart-compact policy-owner toggle (Fix 41 Stage 2)', () => {
  it('parseSmartCompactPolicyOwner maps canonical spellings + rejects garbage', () => {
    expect(parseSmartCompactPolicyOwner('daemon')).toBe('daemon');
    expect(parseSmartCompactPolicyOwner('DAEMON')).toBe('daemon');
    expect(parseSmartCompactPolicyOwner('lex')).toBe('lex');
    expect(parseSmartCompactPolicyOwner('LEX')).toBe('lex');
    expect(parseSmartCompactPolicyOwner('  lex  ')).toBe('lex');
    expect(parseSmartCompactPolicyOwner('')).toBeNull();
    expect(parseSmartCompactPolicyOwner('garbage')).toBeNull();
    expect(parseSmartCompactPolicyOwner(null)).toBeNull();
    expect(parseSmartCompactPolicyOwner(undefined)).toBeNull();
  });

  it("defaults to 'lex' when runtime_config is empty (Fix 41 Stage 3 flipped default)", () => {
    expect(smartCompactPolicyOwner(db)).toBe('lex');
  });

  it("runtime_config 'daemon' overrides the default (rollback path)", () => {
    db.setRuntimeConfig(SMART_COMPACT_POLICY_OWNER_KEY, 'daemon', 'test');
    expect(smartCompactPolicyOwner(db)).toBe('daemon');
    db.setRuntimeConfig(SMART_COMPACT_POLICY_OWNER_KEY, 'lex', 'test');
    expect(smartCompactPolicyOwner(db)).toBe('lex');
  });

  async function buildApp(): Promise<ReturnType<typeof Fastify>> {
    const app = Fastify({ logger: false });
    const injector = vi.fn(() => ({ ok: true as const }));
    registerSmartCompactRoutes(app, db, injector, () => undefined);
    await app.ready();
    return app;
  }

  it("GET /policy-owner returns the current owner + raw runtime value", async () => {
    const app = await buildApp();
    try {
      const res1 = await app.inject({
        method: 'GET',
        url: '/lex/smart-compact/policy-owner',
      });
      expect(res1.statusCode).toBe(200);
      const body1 = res1.json() as {
        owner: string;
        runtime_value: string | null;
        default_owner: string;
      };
      expect(body1.owner).toBe('lex');
      expect(body1.runtime_value).toBeNull();
      expect(body1.default_owner).toBe('lex');

      db.setRuntimeConfig(SMART_COMPACT_POLICY_OWNER_KEY, 'daemon', 'test');
      const res2 = await app.inject({
        method: 'GET',
        url: '/lex/smart-compact/policy-owner',
      });
      const body2 = res2.json() as {
        owner: string;
        runtime_value: string | null;
      };
      expect(body2.owner).toBe('daemon');
      expect(body2.runtime_value).toBe('daemon');
    } finally {
      await app.close();
    }
  });

  it("POST /policy-owner flips the runtime value and 400s on garbage", async () => {
    const app = await buildApp();
    try {
      const badRes = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/policy-owner',
        payload: { owner: 'turbo', updated_by: 'test' },
      });
      expect(badRes.statusCode).toBe(400);
      const badBody = badRes.json() as { error: string };
      expect(badBody.error).toMatch(/owner must be/i);
      /* runtime_config untouched. */
      expect(db.getRuntimeConfig(SMART_COMPACT_POLICY_OWNER_KEY)).toBeNull();

      const okRes = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/policy-owner',
        payload: { owner: 'lex', updated_by: 'test' },
      });
      expect(okRes.statusCode).toBe(200);
      const okBody = okRes.json() as { owner: string };
      expect(okBody.owner).toBe('lex');
      expect(db.getRuntimeConfig(SMART_COMPACT_POLICY_OWNER_KEY)).toBe('lex');
    } finally {
      await app.close();
    }
  });
});

describe('wrapPaste (Fix 41 Stage 1)', () => {
  it('rejects when prompt is empty', () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = wrapPaste(db, 'a', {
      reason: 'forced-no-stop',
      prompt: '',
      injector,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/prompt is required/i);
    expect(injector).not.toHaveBeenCalled();
    expect(recentSmartCompacts(db).length).toBe(0);
  });

  it('rejects when anchor unknown', () => {
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = wrapPaste(db, 'ghost', {
      reason: 'forced-no-stop',
      prompt: 'wrap up',
      injector,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('anchor not found');
    expect(injector).not.toHaveBeenCalled();
  });

  it("returns noop when mode='off' (no audit row, no inject)", () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    db.setRuntimeConfig(SMART_COMPACT_CONFIG_KEY, 'off', 'test');
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = wrapPaste(db, 'a', {
      reason: 'forced-no-stop',
      prompt: 'wrap and commit',
      injector,
    });
    expect(r.ok).toBe(true);
    expect(r.inject_result).toBe('noop');
    expect(r.log_id).toBe('');
    expect(injector).not.toHaveBeenCalled();
    expect(recentSmartCompacts(db).length).toBe(0);
  });

  it('happy path: injects the caller-supplied prompt and writes action=wrap-paste row', () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const prompt =
      'Commit what is stable on smart-compact-routes.ts. Defer the readiness-gate refactor with a TODO.';
    const r = wrapPaste(db, 'a', {
      reason: 'forced-no-stop',
      prompt,
      preCtxPct: 78,
      injector,
    });
    expect(r.ok).toBe(true);
    expect(r.inject_result).toBe('wrap-injected');
    expect(injector).toHaveBeenCalledTimes(1);
    expect(injector).toHaveBeenCalledWith('pty-A', prompt, true);
    const row = recentSmartCompacts(db)[0]!;
    expect(row.action).toBe('wrap-paste');
    expect(row.payload_text).toBe(prompt);
    expect(row.pre_ctx_pct).toBe(78);
  });
});

describe('POST /lex/smart-compact/wrap-paste (Fix 41 Stage 1)', () => {
  async function buildApp(): Promise<{
    app: ReturnType<typeof Fastify>;
    injector: ReturnType<typeof vi.fn>;
  }> {
    const app = Fastify({ logger: false });
    const injector = vi.fn(() => ({ ok: true as const }));
    registerSmartCompactRoutes(app, db, injector, () => undefined);
    await app.ready();
    return { app, injector };
  }

  it('400 when prompt missing', async () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/wrap-paste',
        payload: { anchor_id: 'a', reason: 'forced-no-stop' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/prompt is required/i);
      expect(injector).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('400 when reason missing', async () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/wrap-paste',
        payload: { anchor_id: 'a', prompt: 'wrap up please' },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/reason required/i);
      expect(injector).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('404 when anchor unknown', async () => {
    const { app, injector } = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/wrap-paste',
        payload: {
          anchor_id: 'ghost',
          reason: 'forced-no-stop',
          prompt: 'wrap up',
        },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { error: string };
      expect(body.error).toBe('anchor not found');
      expect(injector).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('happy path: 200 + single inject + audit row action=wrap-paste', async () => {
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const { app, injector } = await buildApp();
    const prompt =
      'Lex-authored wrap: commit the policy-out scaffold; defer cutover.';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lex/smart-compact/wrap-paste',
        payload: {
          anchor_id: 'a',
          reason: 'forced-no-stop',
          prompt,
          pre_ctx_pct: 77,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; inject_result: string };
      expect(body.ok).toBe(true);
      expect(body.inject_result).toBe('wrap-injected');
      expect(injector).toHaveBeenCalledTimes(1);
      expect(injector).toHaveBeenCalledWith('pty-A', prompt, true);
      const row = recentSmartCompacts(db)[0]!;
      expect(row.action).toBe('wrap-paste');
      expect(row.payload_text).toBe(prompt);
      expect(row.pre_ctx_pct).toBe(77);
    } finally {
      await app.close();
    }
  });
});
