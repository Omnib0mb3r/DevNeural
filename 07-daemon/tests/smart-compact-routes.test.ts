/**
 * Smart-compact route handlers.
 *
 * Exercises evaluateSmartCompact + fireSmartCompact + recentSmartCompacts
 * against a tmp DB seeded with project_session rows. PTY transport is
 * injected as a vi.fn() so we can assert /clear + summary deliver and
 * shadow gating skips inject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  evaluateSmartCompact,
  fireSmartCompact,
  parseSmartCompactValue,
  recentSmartCompacts,
  smartCompactMode,
  SMART_COMPACT_CONFIG_KEY,
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

describe('evaluateSmartCompact', () => {
  it('returns 404-style error when anchor is unknown', () => {
    const r = evaluateSmartCompact(db, 'missing');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('anchor not found');
  });

  it('returns wait + null ctx_pct when no transcript ref or ctx provider', () => {
    seedAnchor({ id: 'a' });
    const r = evaluateSmartCompact(db, 'a');
    expect(r.ok).toBe(true);
    expect(r.action).toBe('wait');
    expect(r.ctx_pct).toBeNull();
  });

  it('passes through explicit ctx_pct and phase to the evaluator', () => {
    seedAnchor({ id: 'a' });
    const r = evaluateSmartCompact(db, 'a', {
      ctxPct: 60,
      phase: 'idle',
      lastCommitMs: null,
      lastToolMs: null,
    });
    expect(r.action).toBe('fire');
    expect(r.reason).toBe('window-open');
    expect(typeof r.summary).toBe('string');
    expect(r.summary).toMatch(/Context refreshed/);
  });

  it('returns shadow=true while attempt count is under threshold', () => {
    process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N = '3';
    seedAnchor({ id: 'a' });
    const r = evaluateSmartCompact(db, 'a', { ctxPct: 60, phase: 'idle' });
    expect(r.shadow).toBe(true);
  });
});

describe('fireSmartCompact', () => {
  it('writes a shadow audit row and skips inject while under shadow threshold', () => {
    process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N = '3';
    seedAnchor({ id: 'a' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = fireSmartCompact(db, 'a', {
      caller: 'lex',
      reason: 'window-open',
      action: 'fire',
      ctxPct: 60,
      summary: 'resume here',
      injector,
    });
    expect(r.action).toBe('shadow');
    expect(r.shadow).toBe(true);
    expect(injector).not.toHaveBeenCalled();
    const rows = recentSmartCompacts(db);
    expect(rows[0]!.action).toBe('shadow');
  });

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

  it('force=true bypasses the shadow gate', () => {
    process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N = '3';
    seedAnchor({ id: 'a', pty: 'pty-A' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = fireSmartCompact(db, 'a', {
      caller: 'dashboard',
      reason: 'manual',
      action: 'fire',
      ctxPct: 65,
      summary: 'go',
      injector,
      force: true,
    });
    expect(r.shadow).toBe(false);
    expect(r.action).toBe('fire');
    expect(injector).toHaveBeenCalledTimes(2);
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
     * the default at launch (shadow-only until operator opts in). */
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
        /* force=true would normally bypass the per-anchor shadow
         * counter; the global toggle must still win. */
        force: true,
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
