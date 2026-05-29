/**
 * LEX-AUTONOMY codex 12 (Fix 49) partial closure: insert-path
 * project_scope_id inheritance.
 *
 * insertBrainstorm now reads lex_session.supervises_project_anchor_id
 * for the matching id (migration 018 contract: lex_session.id ==
 * brainstorm_sessions.id) and copies it into the new row's
 * project_scope_id when the caller has not supplied an explicit
 * value. Pure backfill on the insert path: no callsite change in
 * spawnLex / registerBrainstorm / createStandaloneBrainstorm, the
 * scope just appears once a supervisor binding exists.
 *
 * Pins:
 *   1. Insert with a bound lex_session (supervises set) -> brainstorm
 *      row's project_scope_id reflects the anchor id.
 *   2. Insert with a bound lex_session but supervises = NULL -> row
 *      stays NULL.
 *   3. Insert with no matching lex_session row at all -> row stays
 *      NULL (standalone path).
 *   4. Explicit project_scope_id wins over the inherited value
 *      (callers can still override).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb, type BrainstormSessionRow } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

function insertLex(id: string, supervises: string | null): void {
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

function baseRow(id: string): BrainstormSessionRow {
  return {
    id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/p/lex',
    user_label: null,
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: 1_000,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  };
}

function readScope(id: string): string | null {
  const row = db.getBrainstorm(id);
  return row ? (row.project_scope_id ?? null) : null;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-scope-insert-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  /* Seed the FK target so insertLexSession with a non-null
   * supervises pointer satisfies migration 025's project_session
   * foreign key. */
  db.insertProjectSession({
    id: 'anchor-proj-1',
    project_slug: 'devneural',
    cwd: 'C:/p/devneural',
    title: null,
    status: 'live',
    current_session_id: 'cc-live',
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1_000,
    last_seen_ms: 1_000,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('insertBrainstorm project_scope_id inheritance', () => {
  it('inherits supervises_project_anchor_id from the matching lex_session row', () => {
    insertLex('bs-1', 'anchor-proj-1');
    db.insertBrainstorm(baseRow('bs-1'));
    expect(readScope('bs-1')).toBe('anchor-proj-1');
  });

  it('stays NULL when the bound lex_session has no supervisor binding', () => {
    insertLex('bs-2', null);
    db.insertBrainstorm(baseRow('bs-2'));
    expect(readScope('bs-2')).toBeNull();
  });

  it('stays NULL when there is no matching lex_session row at all (standalone path)', () => {
    db.insertBrainstorm(baseRow('bs-3'));
    expect(readScope('bs-3')).toBeNull();
  });

  it('honours an explicit project_scope_id over the inherited value', () => {
    insertLex('bs-4', 'anchor-proj-1');
    const row = baseRow('bs-4');
    row.project_scope_id = 'explicit-scope';
    db.insertBrainstorm(row);
    expect(readScope('bs-4')).toBe('explicit-scope');
  });
});
