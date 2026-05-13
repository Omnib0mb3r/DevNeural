/**
 * Phase C: brainstorm-to-project binding regression suite.
 *
 * Pins the three contracts the binding promises:
 *   1. Migration 025 adds the supervises_project_anchor_id column
 *      with a project_session FK; setLexSessionSupervises persists
 *      and clears it through the new helper.
 *   2. resolveSupervisedTargetSession returns the project's
 *      current_session_id when bound + live, null when unbound or
 *      when the project anchor is dormant / missing.
 *   3. setLexSessionSupervises rejects neither cleared (null) nor
 *      a valid project_session id; tests for the PATCH endpoint's
 *      422-on-missing-target live in the e2e suite (skipped here to
 *      avoid wiring fastify for one assertion).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { resolveSupervisedTargetSession } from '../src/dashboard/routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

function insertLex(id: string, supervises: string | null = null): void {
  db.insertLexSession({
    id,
    created_ms: 1_000,
    title: null,
    derived_title: null,
    status: 'dormant',
    current_pty_id: null,
    cwd: 'C:/p/lex',
    supervises_project_anchor_id: supervises,
  });
}

function insertProject(
  id: string,
  slug: string,
  ccSessionId: string | null,
  status: 'live' | 'dormant' = 'live',
): void {
  db.insertProjectSession({
    id,
    project_slug: slug,
    cwd: `C:/p/${slug}`,
    title: null,
    status,
    current_session_id: ccSessionId,
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1_000,
    last_seen_ms: 1_000,
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-supervises-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 025 + setLexSessionSupervises', () => {
  it('adds the column with a NULL default and round-trips through the setter', () => {
    insertLex('lex-1', null);
    expect(db.getLexSession('lex-1')?.supervises_project_anchor_id).toBeFalsy();
    insertProject('proj-1', 'devneural', 'cc-live');
    const after = db.setLexSessionSupervises('lex-1', 'proj-1');
    expect(after?.supervises_project_anchor_id).toBe('proj-1');
    /* Reads project_session by FK */
    expect(db.getProjectSession('proj-1')).toBeTruthy();
    /* Clear path */
    const cleared = db.setLexSessionSupervises('lex-1', null);
    expect(cleared?.supervises_project_anchor_id).toBeNull();
  });
});

describe('resolveSupervisedTargetSession', () => {
  it('returns the bound project current_session_id when both rows exist + live', () => {
    insertProject('proj-A', 'devneural', 'cc-A-live');
    insertLex('lex-bound', 'proj-A');
    expect(resolveSupervisedTargetSession(db, 'lex-bound')).toBe('cc-A-live');
  });

  it('returns null when the brainstorm anchor has no binding', () => {
    insertLex('lex-unbound', null);
    expect(resolveSupervisedTargetSession(db, 'lex-unbound')).toBeNull();
  });

  it('returns null when the bound project anchor has no current session (dormant)', () => {
    insertProject('proj-dormant', 'devneural-2', null, 'dormant');
    insertLex('lex-stale', 'proj-dormant');
    expect(resolveSupervisedTargetSession(db, 'lex-stale')).toBeNull();
  });

  it('returns null for a brainstorm anchor that does not exist', () => {
    expect(resolveSupervisedTargetSession(db, 'ghost-id')).toBeNull();
  });
});
