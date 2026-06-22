/**
 * Lifecycle stage persistence (DRIVE-QUEUE 3). Pins that the migration-045
 * `stage` column round-trips through insert / updateProjectSession /
 * getProjectSession, and that effectiveStage resolves the NULL default
 * the GET endpoint relies on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { IndexDb, type ProjectSessionRow } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { effectiveStage } from '../src/lex/project-lifecycle.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-stage-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedSession(status: 'live' | 'dormant'): ProjectSessionRow {
  const id = randomUUID();
  const row: ProjectSessionRow = {
    id,
    project_slug: `proj-${id}`, // project_slug + cwd are both UNIQUE
    cwd: `/tmp/proj-${id}`,
    title: 'Proj',
    status,
    current_session_id: null,
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: Date.now(),
    last_seen_ms: Date.now(),
  };
  void id;
  db.insertProjectSession(row);
  return row;
}

describe('project_session.stage persistence', () => {
  it('defaults to NULL on insert (no behavior change for existing rows)', () => {
    const row = seedSession('live');
    expect(db.getProjectSession(row.id)?.stage ?? null).toBeNull();
  });

  it('round-trips a stage set via updateProjectSession', () => {
    const row = seedSession('dormant');
    db.updateProjectSession(row.id, { stage: 'spec' });
    expect(db.getProjectSession(row.id)?.stage).toBe('spec');
    db.updateProjectSession(row.id, { stage: 'tdd' });
    expect(db.getProjectSession(row.id)?.stage).toBe('tdd');
  });

  it('effectiveStage applies the NULL default the GET endpoint uses', () => {
    const live = seedSession('live');
    const dormant = seedSession('dormant');
    expect(effectiveStage(db.getProjectSession(live.id)!)).toBe('execution');
    expect(effectiveStage(db.getProjectSession(dormant.id)!)).toBe('new_project');
    db.updateProjectSession(dormant.id, { stage: 'spec' });
    expect(effectiveStage(db.getProjectSession(dormant.id)!)).toBe('spec');
  });
});
