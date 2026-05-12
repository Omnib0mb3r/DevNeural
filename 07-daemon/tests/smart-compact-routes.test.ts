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
  recentSmartCompacts,
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
  };
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'Projects');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  /* Set shadow gate to 0 so tests can drive live behavior without
   * burning through fake rows. The shadow-specific test sets it back. */
  process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N = '0';

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
    current_session_id: opts.cc ?? 'cc-' + opts.id,
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

  it('records inject_result=pty_not_found when anchor has no current_pty_id', () => {
    seedAnchor({ id: 'a', pty: null });
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
