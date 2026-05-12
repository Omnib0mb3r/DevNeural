/**
 * Migration 019 (project anchors) — schema + backfill + seeding.
 *
 * Uses a temp directory for both the DB and the simulated home /
 * projects-root environment. Lazy env reads inside the migration
 * module make per-test overrides possible without monkey-patching.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { IndexDb } from '../../src/store/index-db.js';
import { runMigrations } from '../../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', '..', 'scripts', 'migrations');

interface Env {
  tmpDir: string;
  dbFile: string;
  homeDir: string;
  claudeProjects: string;
  projectsRoot: string;
  priorUserprofile: string | undefined;
  priorHome: string | undefined;
  priorProjectsRoot: string | undefined;
  priorDataRoot: string | undefined;
}

let env: Env;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-mig019-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const homeDir = path.join(tmpDir, 'home');
  const claudeProjects = path.join(homeDir, '.claude', 'projects');
  const projectsRoot = path.join(tmpDir, 'Projects');
  fs.mkdirSync(claudeProjects, { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });

  const idx = new IndexDb(dbFile);
  idx.close();

  env = {
    tmpDir,
    dbFile,
    homeDir,
    claudeProjects,
    projectsRoot,
    priorUserprofile: process.env.USERPROFILE,
    priorHome: process.env.HOME,
    priorProjectsRoot: process.env.DEVNEURAL_PROJECTS_ROOT,
    priorDataRoot: process.env.DEVNEURAL_DATA_ROOT,
  };
  /* os.homedir() honors USERPROFILE on Windows and HOME on POSIX.
   * Set both so the migration's claudeProjectsDir() resolves into
   * the temp home regardless of platform. */
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = projectsRoot.replace(/\\/g, '/');
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  const restore = (k: 'USERPROFILE' | 'HOME' | 'DEVNEURAL_PROJECTS_ROOT' | 'DEVNEURAL_DATA_ROOT', v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('USERPROFILE', env.priorUserprofile);
  restore('HOME', env.priorHome);
  restore('DEVNEURAL_PROJECTS_ROOT', env.priorProjectsRoot);
  restore('DEVNEURAL_DATA_ROOT', env.priorDataRoot);
  fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

function writeJsonl(
  slugDir: string,
  ccSessionId: string,
  cwd: string,
  timestamp: string,
): string {
  fs.mkdirSync(slugDir, { recursive: true });
  const file = path.join(slugDir, `${ccSessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'summary',
      cwd: cwd,
      sessionId: ccSessionId,
      timestamp,
    }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  return file;
}

describe('migration 019 — project anchors', () => {
  it('creates project_session and project_transcript_ref tables', async () => {
    await runMigrations({
      dbPath: env.dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });
    const db = new Database(env.dbFile);
    try {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
        )
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain('project_session');
      expect(names).toContain('project_transcript_ref');

      const cols = db
        .prepare(`PRAGMA table_info(project_session)`)
        .all() as { name: string }[];
      const colNames = cols.map((c) => c.name);
      for (const c of [
        'id',
        'project_slug',
        'cwd',
        'title',
        'status',
        'current_session_id',
        'current_bridge_id',
        'current_pty_id',
        'created_ms',
        'last_seen_ms',
      ]) {
        expect(colNames).toContain(c);
      }
    } finally {
      db.close();
    }
  });

  it('backfills anchors from ~/.claude/projects jsonls grouped by cwd', async () => {
    const cwdA = 'C:/dev/Projects/foo';
    const cwdB = 'C:/dev/Projects/bar';
    writeJsonl(
      path.join(env.claudeProjects, 'c--dev-Projects-foo'),
      '11111111-1111-1111-1111-111111111111',
      cwdA,
      '2026-05-01T10:00:00.000Z',
    );
    writeJsonl(
      path.join(env.claudeProjects, 'c--dev-Projects-foo'),
      '22222222-2222-2222-2222-222222222222',
      cwdA,
      '2026-05-02T10:00:00.000Z',
    );
    writeJsonl(
      path.join(env.claudeProjects, 'c--dev-Projects-bar'),
      '33333333-3333-3333-3333-333333333333',
      cwdB,
      '2026-05-03T10:00:00.000Z',
    );

    await runMigrations({
      dbPath: env.dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });

    const db = new Database(env.dbFile);
    try {
      const anchors = db
        .prepare(`SELECT cwd, project_slug, status FROM project_session ORDER BY cwd`)
        .all() as { cwd: string; project_slug: string; status: string }[];
      const cwds = anchors.map((a) => a.cwd);
      expect(cwds).toContain(cwdA);
      expect(cwds).toContain(cwdB);
      for (const a of anchors) {
        expect(a.status).toBe('dormant');
      }

      const refsFoo = db
        .prepare(
          `SELECT cc_session_id FROM project_transcript_ref
             JOIN project_session ON project_transcript_ref.anchor_id = project_session.id
            WHERE project_session.cwd = ?`,
        )
        .all(cwdA) as { cc_session_id: string }[];
      expect(refsFoo.map((r) => r.cc_session_id).sort()).toEqual([
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ]);
    } finally {
      db.close();
    }
  });

  it('seeds DEVNEURAL_PROJECTS_ROOT subdirs as dormant anchors with no transcript_refs', async () => {
    fs.mkdirSync(path.join(env.projectsRoot, 'never-launched'), { recursive: true });
    fs.mkdirSync(path.join(env.projectsRoot, 'also-never'), { recursive: true });
    fs.writeFileSync(path.join(env.projectsRoot, 'not-a-dir.txt'), 'x', 'utf-8');

    await runMigrations({
      dbPath: env.dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });

    const db = new Database(env.dbFile);
    try {
      const rows = db
        .prepare(
          `SELECT project_slug, status FROM project_session ORDER BY project_slug`,
        )
        .all() as { project_slug: string; status: string }[];
      const slugs = rows.map((r) => r.project_slug);
      expect(slugs).toContain('never-launched');
      expect(slugs).toContain('also-never');
      expect(slugs).not.toContain('not-a-dir.txt');
      for (const r of rows) expect(r.status).toBe('dormant');

      const refs = db
        .prepare(`SELECT COUNT(*) AS n FROM project_transcript_ref`)
        .get() as { n: number };
      expect(refs.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('is idempotent: a second run inserts no new anchors or refs', async () => {
    const cwd = 'C:/dev/Projects/idem';
    writeJsonl(
      path.join(env.claudeProjects, 'c--dev-Projects-idem'),
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      cwd,
      '2026-05-01T10:00:00.000Z',
    );
    fs.mkdirSync(path.join(env.projectsRoot, 'idle'), { recursive: true });

    await runMigrations({
      dbPath: env.dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });
    const r2 = await runMigrations({
      dbPath: env.dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });
    expect(r2.applied).toEqual([]);

    const db = new Database(env.dbFile);
    try {
      const anchorsBefore = (
        db.prepare(`SELECT COUNT(*) AS n FROM project_session`).get() as {
          n: number;
        }
      ).n;
      const refsBefore = (
        db.prepare(`SELECT COUNT(*) AS n FROM project_transcript_ref`).get() as {
          n: number;
        }
      ).n;
      expect(anchorsBefore).toBeGreaterThan(0);
      expect(refsBefore).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('FK cascade: deleting an anchor removes its transcript_refs', async () => {
    const cwd = 'C:/dev/Projects/cascade';
    writeJsonl(
      path.join(env.claudeProjects, 'c--dev-Projects-cascade'),
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      cwd,
      '2026-05-01T10:00:00.000Z',
    );

    await runMigrations({
      dbPath: env.dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });

    const db = new Database(env.dbFile);
    db.pragma('foreign_keys = ON');
    try {
      const anchor = db
        .prepare(`SELECT id FROM project_session WHERE cwd = ?`)
        .get(cwd) as { id: string } | undefined;
      expect(anchor).toBeDefined();
      db.prepare(`DELETE FROM project_session WHERE id = ?`).run(anchor!.id);
      const refs = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM project_transcript_ref WHERE anchor_id = ?`,
          )
          .get(anchor!.id) as { n: number }
      ).n;
      expect(refs).toBe(0);
    } finally {
      db.close();
    }
  });

  it('disambiguates slug collisions across distinct cwds', async () => {
    const cwd1 = 'C:/dev/Projects/foo';
    const cwd2 = 'D:/elsewhere/foo';
    writeJsonl(
      path.join(env.claudeProjects, 'a'),
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      cwd1,
      '2026-05-01T10:00:00.000Z',
    );
    writeJsonl(
      path.join(env.claudeProjects, 'b'),
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      cwd2,
      '2026-05-01T11:00:00.000Z',
    );

    await runMigrations({
      dbPath: env.dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });

    const db = new Database(env.dbFile);
    try {
      const rows = db
        .prepare(
          `SELECT cwd, project_slug FROM project_session
            WHERE cwd IN (?, ?) ORDER BY cwd`,
        )
        .all(cwd1, cwd2) as { cwd: string; project_slug: string }[];
      expect(rows.length).toBe(2);
      const slugs = rows.map((r) => r.project_slug);
      expect(new Set(slugs).size).toBe(2);
    } finally {
      db.close();
    }
  });

  it('rejects status values outside live/dormant', async () => {
    await runMigrations({
      dbPath: env.dbFile,
      migrationsDir: MIGRATIONS_DIR,
    });
    const db = new Database(env.dbFile);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO project_session
               (id, project_slug, cwd, status, created_ms, last_seen_ms)
             VALUES ('x', 'x', 'X:/x', 'wat', 1, 1)`,
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
