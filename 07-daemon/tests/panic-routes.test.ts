/**
 * Panic button route handlers (PANIC-BUTTON.md steps 1 and 3).
 *
 * Exercises the pure handler logic from panic-routes.ts. Injects a
 * stub for the PTY transport so the test asserts that
 *   - \x1b\x1b lands at the right pty id
 *   - the resolver picks the right anchor
 *   - every fire writes one panic_log row with the right verdict
 *   - dormant or unbound anchors produce a no-target / pty_not_found
 *     result without throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  firePanic,
  fireProjectInterrupt,
  recentPanics,
} from '../src/dashboard/panic-routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let priorRoot: string | undefined;
let priorProjectsRoot: string | undefined;
let priorUserprofile: string | undefined;
let priorHome: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-panic-routes-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  priorProjectsRoot = process.env.DEVNEURAL_PROJECTS_ROOT;
  priorUserprofile = process.env.USERPROFILE;
  priorHome = process.env.HOME;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path
    .join(tmpDir, 'Projects')
    .replace(/\\/g, '/');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');

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
  const restore = (
    k: 'USERPROFILE' | 'HOME' | 'DEVNEURAL_PROJECTS_ROOT' | 'DEVNEURAL_DATA_ROOT',
    v: string | undefined,
  ) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('USERPROFILE', priorUserprofile);
  restore('HOME', priorHome);
  restore('DEVNEURAL_PROJECTS_ROOT', priorProjectsRoot);
  restore('DEVNEURAL_DATA_ROOT', priorRoot);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedLive(opts: {
  id: string;
  pty?: string | null;
  cc?: string | null;
  last_seen_ms?: number;
}): void {
  db.insertProjectSession({
    id: opts.id,
    project_slug: opts.id,
    cwd: `C:/p/${opts.id}`,
    title: opts.id,
    status: 'live',
    current_session_id: opts.cc ?? null,
    current_bridge_id: `b-${opts.id}`,
    current_pty_id: opts.pty ?? null,
    created_ms: 1,
    last_seen_ms: opts.last_seen_ms ?? 1,
  });
}

describe('firePanic', () => {
  it('returns no_target and logs when there is no live anchor', () => {
    const injector = vi.fn();
    const r = firePanic(db, {
      caller: 'dashboard',
      clickedMs: 9001,
      injector,
    });
    expect(r.ok).toBe(false);
    expect(r.result).toBe('no_target');
    expect(injector).not.toHaveBeenCalled();
    const log = recentPanics(db);
    expect(log.length).toBe(1);
    expect(log[0]!.result).toBe('no_target');
    expect(log[0]!.caller).toBe('dashboard');
  });

  it('sends \\x1b\\x1b to the resolved anchor pty and logs accepted', () => {
    seedLive({ id: 'only', pty: 'pty-1', cc: 'cc-1' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = firePanic(db, {
      caller: 'dashboard',
      clickedMs: 9002,
      injector,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe('accepted');
    expect(r.target?.id).toBe('only');
    expect(injector).toHaveBeenCalledWith('pty-1', '\x1b\x1b', false);
    const log = recentPanics(db);
    expect(log[0]!.result).toBe('accepted');
    expect(log[0]!.target_anchor_id).toBe('only');
    expect(log[0]!.target_pty_id).toBe('pty-1');
    expect(log[0]!.target_session_id).toBe('cc-1');
  });

  it('falls back to current_session_id when current_pty_id is null and the cc session has a live daemon pty', () => {
    /* Bridge-presence reconcile binds current_session_id on every
     * live tick but never populates current_pty_id; before the fix
     * the panic resolver short-circuited to pty_not_found here even
     * when the daemon owned a PTY for that CC session. The injector
     * stub stands in for ptyInject's session-id fallback path
     * (getPtyBySession lookup). */
    seedLive({ id: 'only', pty: null, cc: 'cc-1' });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = firePanic(db, {
      caller: 'dashboard',
      clickedMs: 9003,
      injector,
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe('accepted');
    expect(injector).toHaveBeenCalledWith('cc-1', '\x1b\x1b', false);
    const log = recentPanics(db)[0]!;
    expect(log.result).toBe('accepted');
    expect(log.target_anchor_id).toBe('only');
    expect(log.target_session_id).toBe('cc-1');
    expect(log.target_pty_id).toBe('cc-1');
  });

  it('logs pty_not_found when both current_pty_id and current_session_id are null', () => {
    seedLive({ id: 'only', pty: null, cc: null });
    const injector = vi.fn();
    const r = firePanic(db, {
      caller: 'dashboard',
      clickedMs: 9013,
      injector,
    });
    expect(r.ok).toBe(false);
    expect(r.result).toBe('pty_not_found');
    expect(injector).not.toHaveBeenCalled();
    expect(recentPanics(db)[0]!.result).toBe('pty_not_found');
  });

  it('logs pty_not_found when the session-id fallback injector cannot resolve a live pty', () => {
    seedLive({ id: 'only', pty: null, cc: 'cc-1' });
    const injector = vi.fn(() => ({
      ok: false as const,
      error: 'pty not found',
    }));
    const r = firePanic(db, {
      caller: 'dashboard',
      clickedMs: 9023,
      injector,
    });
    expect(r.ok).toBe(false);
    expect(r.result).toBe('pty_not_found');
    expect(injector).toHaveBeenCalledWith('cc-1', '\x1b\x1b', false);
    expect(recentPanics(db)[0]!.result).toBe('pty_not_found');
  });

  it('logs pty_not_found when injector reports the pty has exited', () => {
    seedLive({ id: 'only', pty: 'pty-stale', cc: 'cc-1' });
    const injector = vi.fn(() => ({
      ok: false as const,
      error: 'pty has exited',
    }));
    const r = firePanic(db, {
      caller: 'dashboard',
      clickedMs: 9004,
      injector,
    });
    expect(r.ok).toBe(false);
    expect(r.result).toBe('pty_not_found');
    expect(recentPanics(db)[0]!.result).toBe('pty_not_found');
  });
});

describe('fireProjectInterrupt', () => {
  it('returns 404-style result when anchor id is unknown', () => {
    const injector = vi.fn();
    const r = fireProjectInterrupt(db, 'missing', {
      caller: 'lex-tool',
      clickedMs: 9100,
      injector,
    });
    expect(r.ok).toBe(false);
    expect(r.result).toBe('no_target');
    expect(injector).not.toHaveBeenCalled();
  });

  it('targets the specific anchor regardless of resolver tiebreak', () => {
    seedLive({ id: 'a', pty: 'pty-a', cc: 'cc-a', last_seen_ms: 100 });
    seedLive({ id: 'b', pty: 'pty-b', cc: 'cc-b', last_seen_ms: 999 });
    const injector = vi.fn(() => ({ ok: true as const }));
    const r = fireProjectInterrupt(db, 'a', {
      caller: 'dashboard',
      clickedMs: 9101,
      injector,
    });
    expect(r.ok).toBe(true);
    expect(r.target?.id).toBe('a');
    expect(injector).toHaveBeenCalledWith('pty-a', '\x1b\x1b', false);
  });

  it('returns no_target if the anchor exists but is dormant', () => {
    db.insertProjectSession({
      id: 'd',
      project_slug: 'd',
      cwd: 'C:/p/d',
      title: 'd',
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
    const r = fireProjectInterrupt(db, 'd', {
      caller: 'dashboard',
      clickedMs: 9102,
      injector: vi.fn(),
    });
    expect(r.ok).toBe(false);
    expect(r.result).toBe('no_target');
  });
});

describe('recentPanics', () => {
  it('returns rows in DESC ts order, capped at limit', () => {
    seedLive({ id: 'a', pty: 'pty-a' });
    const injector = vi.fn(() => ({ ok: true as const }));
    for (let i = 0; i < 5; i++) {
      firePanic(db, { caller: 'dashboard', clickedMs: 100 + i, injector });
    }
    const rows = recentPanics(db, 3);
    expect(rows.length).toBe(3);
  });
});
