/**
 * Panic single-target resolver (PANIC-BUTTON.md step 2).
 *
 * 1. exactly one live anchor          -> that anchor
 * 2. multiple live, one thinking/tool -> that anchor
 * 3. tie on phase                     -> most recent last_activity_ms
 * 4. no live                          -> null
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { resolvePanicTarget } from '../src/dashboard/panic-target.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let priorRoot: string | undefined;
let priorProjectsRoot: string | undefined;
let priorUserprofile: string | undefined;
let priorHome: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-panic-target-'));
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

function seedAnchor(opts: {
  id: string;
  status?: 'live' | 'dormant';
  current_session_id?: string | null;
  current_pty_id?: string | null;
  last_seen_ms?: number;
}): void {
  db.insertProjectSession({
    id: opts.id,
    project_slug: opts.id,
    cwd: `C:/p/${opts.id}`,
    title: opts.id,
    status: opts.status ?? 'live',
    current_session_id: opts.current_session_id ?? null,
    current_bridge_id: 'b-' + opts.id,
    current_pty_id: opts.current_pty_id ?? null,
    created_ms: 1,
    last_seen_ms: opts.last_seen_ms ?? 1,
  });
}

describe('resolvePanicTarget', () => {
  it('returns null when no live anchors', () => {
    seedAnchor({ id: 'a', status: 'dormant' });
    expect(resolvePanicTarget(db).target).toBeNull();
  });

  it('returns the sole live anchor when there is exactly one', () => {
    seedAnchor({ id: 'only', status: 'live', last_seen_ms: 100 });
    const r = resolvePanicTarget(db);
    expect(r.target?.id).toBe('only');
    expect(r.reason).toBe('sole-live');
  });

  it('prefers anchor whose phase is thinking or tool over idle when multiple live', () => {
    seedAnchor({
      id: 'idle',
      status: 'live',
      current_session_id: 'cc-idle',
      last_seen_ms: 200,
    });
    seedAnchor({
      id: 'busy',
      status: 'live',
      current_session_id: 'cc-busy',
      last_seen_ms: 100,
    });
    const r = resolvePanicTarget(db, {
      phaseResolver: (cc) => (cc === 'cc-busy' ? 'thinking' : 'idle'),
    });
    expect(r.target?.id).toBe('busy');
    expect(r.reason).toBe('busy-phase');
  });

  it('falls back to most recent last_activity_ms when no busy phase', () => {
    seedAnchor({ id: 'older', status: 'live', last_seen_ms: 100 });
    seedAnchor({ id: 'newer', status: 'live', last_seen_ms: 500 });
    const r = resolvePanicTarget(db, { phaseResolver: () => 'idle' });
    expect(r.target?.id).toBe('newer');
    expect(r.reason).toBe('most-recent');
  });

  it('handles tool phase the same as thinking', () => {
    seedAnchor({
      id: 'a',
      status: 'live',
      current_session_id: 'cc-a',
      last_seen_ms: 100,
    });
    seedAnchor({
      id: 'b',
      status: 'live',
      current_session_id: 'cc-b',
      last_seen_ms: 200,
    });
    const r = resolvePanicTarget(db, {
      phaseResolver: (cc) => (cc === 'cc-a' ? 'tool' : 'idle'),
    });
    expect(r.target?.id).toBe('a');
  });

  it('picks most-recent among multiple thinking/tool anchors', () => {
    seedAnchor({
      id: 'older-busy',
      status: 'live',
      current_session_id: 'cc-1',
      last_seen_ms: 100,
    });
    seedAnchor({
      id: 'newer-busy',
      status: 'live',
      current_session_id: 'cc-2',
      last_seen_ms: 500,
    });
    const r = resolvePanicTarget(db, { phaseResolver: () => 'thinking' });
    expect(r.target?.id).toBe('newer-busy');
  });
});
