/**
 * supervision_mode patch coverage
 * (EVENT-DRIVEN-SUPERVISION.md step 4 dashboard toggle backend).
 *
 * Asserts the PATCH /projects/:id surface accepts and persists
 * supervision_mode in {'polling', 'event', 'off'}, that the anchor
 * view surfaces it, and that invalid values are rejected silently
 * (leaving the existing value in place).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { patchProjectAnchor } from '../src/dashboard/projects-routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-sup-mode-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'Projects');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } })
    .db.prepare('DELETE FROM project_session')
    .run();
  db.insertProjectSession({
    id: 'anchor-A',
    project_slug: 'proj-a',
    cwd: 'C:/p/a',
    title: 'proj-a',
    status: 'live',
    current_session_id: null,
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1,
    last_seen_ms: 1,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('patchProjectAnchor supervision_mode', () => {
  it('defaults to event when no patch supplied (2026-07-16 operator directive)', () => {
    const view = patchProjectAnchor(db, 'anchor-A', {});
    expect(view?.supervision_mode).toBe('event');
  });

  it('persists polling -> event', () => {
    const view = patchProjectAnchor(db, 'anchor-A', {
      supervision_mode: 'event',
    });
    expect(view?.supervision_mode).toBe('event');
    const reread = db.getProjectSession('anchor-A');
    expect(reread?.supervision_mode).toBe('event');
  });

  it('persists polling -> off', () => {
    const view = patchProjectAnchor(db, 'anchor-A', {
      supervision_mode: 'off',
    });
    expect(view?.supervision_mode).toBe('off');
  });

  it('ignores invalid enum values, keeping prior mode', () => {
    patchProjectAnchor(db, 'anchor-A', { supervision_mode: 'event' });
    const view = patchProjectAnchor(db, 'anchor-A', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supervision_mode: 'nonsense' as any,
    });
    expect(view?.supervision_mode).toBe('event');
  });

  it('returns null for an unknown anchor id', () => {
    expect(
      patchProjectAnchor(db, 'missing', { supervision_mode: 'event' }),
    ).toBeNull();
  });

  it('can patch title and supervision_mode in the same call', () => {
    const view = patchProjectAnchor(db, 'anchor-A', {
      title: 'New Title',
      supervision_mode: 'event',
    });
    expect(view?.title).toBe('New Title');
    expect(view?.supervision_mode).toBe('event');
  });
});
