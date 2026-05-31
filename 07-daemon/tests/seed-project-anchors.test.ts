/**
 * seed-project-anchors tests (PROJECT-ANCHORS.md `## Seeding`).
 *
 * Pins boot-time enumeration of the projects root + idempotent upsert.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  DEFAULT_PROJECTS_ROOT,
  PROJECTS_ROOT_ENV,
  ensureAnchorForCwd,
  getProjectsRoot,
  normalizeCwd,
  seedProjectAnchors,
} from '../src/dashboard/seed-project-anchors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

interface Env {
  tmpDir: string;
  dbFile: string;
  projectsRoot: string;
  priorProjectsRoot: string | undefined;
  priorDataRoot: string | undefined;
}

let env: Env;
let db: IndexDb;

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-seed-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const projectsRoot = path.join(tmpDir, 'Projects');
  fs.mkdirSync(projectsRoot, { recursive: true });

  env = {
    tmpDir,
    dbFile,
    projectsRoot,
    priorProjectsRoot: process.env[PROJECTS_ROOT_ENV],
    priorDataRoot: process.env.DEVNEURAL_DATA_ROOT,
  };
  process.env[PROJECTS_ROOT_ENV] = projectsRoot.replace(/\\/g, '/');
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;

  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);

  /* Wipe rows that migration 019 may have inserted from the real
   * C:/dev/Projects tree; tests want a clean slate. */
  (db as unknown as { db: { exec(sql: string): void } }).db.exec(
    'DELETE FROM project_session',
  );
});

afterEach(() => {
  db.close();
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore(PROJECTS_ROOT_ENV, env.priorProjectsRoot);
  restore('DEVNEURAL_DATA_ROOT', env.priorDataRoot);
  fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

function mkdirs(...names: string[]): void {
  for (const n of names) {
    fs.mkdirSync(path.join(env.projectsRoot, n), { recursive: true });
  }
}

function touch(name: string): void {
  fs.writeFileSync(path.join(env.projectsRoot, name), '', 'utf-8');
}

describe('getProjectsRoot', () => {
  it('honours DEVNEURAL_PROJECTS_ROOT env override', () => {
    process.env[PROJECTS_ROOT_ENV] = 'D:/elsewhere/Projects';
    expect(getProjectsRoot()).toBe('D:/elsewhere/Projects');
  });

  it('falls back to DEFAULT_PROJECTS_ROOT when env unset', () => {
    delete process.env[PROJECTS_ROOT_ENV];
    expect(getProjectsRoot()).toBe(DEFAULT_PROJECTS_ROOT);
  });

  it('normalises backslashes and trailing slashes', () => {
    process.env[PROJECTS_ROOT_ENV] = 'D:\\Code\\Projects\\';
    expect(getProjectsRoot()).toBe('D:/Code/Projects');
  });
});

describe('normalizeCwd', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeCwd('C:\\dev\\Projects\\foo')).toBe('C:/dev/Projects/foo');
  });
  it('strips trailing slashes', () => {
    expect(normalizeCwd('C:/dev/Projects/foo/')).toBe('C:/dev/Projects/foo');
  });
  it('strips multiple trailing slashes', () => {
    expect(normalizeCwd('C:/dev/Projects/foo///')).toBe('C:/dev/Projects/foo');
  });
});

describe('seedProjectAnchors', () => {
  it('upserts one row per top-level directory', () => {
    mkdirs('alpha', 'beta', 'gamma');
    const result = seedProjectAnchors(db, { root: env.projectsRoot });
    expect(result.inserted).toBe(3);
    const slugs = (
      (db as unknown as { db: { prepare(s: string): { all(): Array<{ project_slug: string }> } } }).db
        .prepare('SELECT project_slug FROM project_session ORDER BY project_slug')
        .all()
    ).map((r) => r.project_slug);
    expect(slugs).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('is idempotent across re-runs', () => {
    mkdirs('alpha', 'beta');
    const first = seedProjectAnchors(db, { root: env.projectsRoot });
    const second = seedProjectAnchors(db, { root: env.projectsRoot });
    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.scanned).toBe(2);
  });

  it('skips non-directories at the projects root', () => {
    mkdirs('real-project');
    touch('README.md');
    touch('a-loose-file.txt');
    const result = seedProjectAnchors(db, { root: env.projectsRoot });
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('skips dotfile directories', () => {
    mkdirs('visible', '.git', '.vscode');
    const result = seedProjectAnchors(db, { root: env.projectsRoot });
    expect(result.inserted).toBe(1);
    const cwds = (
      (db as unknown as { db: { prepare(s: string): { all(): Array<{ cwd: string }> } } }).db
        .prepare('SELECT cwd FROM project_session')
        .all()
    ).map((r) => r.cwd);
    expect(cwds).toEqual([normalizeCwd(path.posix.join(env.projectsRoot.replace(/\\/g, '/'), 'visible'))]);
  });

  it('honours DEVNEURAL_PROJECTS_ROOT when root option is omitted', () => {
    mkdirs('env-driven');
    const result = seedProjectAnchors(db, { log: () => undefined });
    expect(result.inserted).toBe(1);
    expect(result.root).toBe(normalizeCwd(env.projectsRoot));
  });

  it('returns zero counts when root does not exist', () => {
    fs.rmSync(env.projectsRoot, { recursive: true, force: true });
    const result = seedProjectAnchors(db, { root: env.projectsRoot });
    expect(result.inserted).toBe(0);
    expect(result.scanned).toBe(0);
  });

  it('stamps created rows as dormant with null current_* fields', () => {
    mkdirs('alpha');
    seedProjectAnchors(db, { root: env.projectsRoot });
    const row = db.getProjectSessionByCwd(
      normalizeCwd(path.posix.join(env.projectsRoot.replace(/\\/g, '/'), 'alpha')),
    );
    expect(row?.status).toBe('dormant');
    expect(row?.current_session_id).toBeNull();
    expect(row?.current_bridge_id).toBeNull();
    expect(row?.current_pty_id).toBeNull();
  });
});

describe('ensureAnchorForCwd', () => {
  it('creates a row when no anchor exists for the cwd', () => {
    const created = ensureAnchorForCwd(db, 'C:/dev/Projects/brand-new', {
      now: 9_000_000,
    });
    expect(created).not.toBeNull();
    expect(created?.status).toBe('dormant');
    expect(created?.cwd).toBe('C:/dev/Projects/brand-new');
    expect(created?.project_slug).toBe('brand-new');
    expect(created?.created_ms).toBe(9_000_000);
  });

  it('returns null when an anchor already exists', () => {
    ensureAnchorForCwd(db, 'C:/dev/Projects/dup', { now: 1 });
    const second = ensureAnchorForCwd(db, 'C:/dev/Projects/dup', { now: 2 });
    expect(second).toBeNull();
  });

  it('normalises cwd before lookup so backslash variants do not double-create', () => {
    ensureAnchorForCwd(db, 'C:/dev/Projects/twin', { now: 1 });
    const second = ensureAnchorForCwd(db, 'C:\\dev\\Projects\\twin\\', { now: 2 });
    expect(second).toBeNull();
  });
});
