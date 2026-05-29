/**
 * LEX-AUTONOMY codex 12b (Fix 49 partial closure step 3): PATCH
 * /brainstorms/:id/project-scope helper pins.
 *
 * Exercises patchBrainstormProjectScope against an in-memory IndexDb
 * with a seeded brainstorm row. The fastify route handler is a thin
 * wrapper around the helper so these unit pins cover the contract
 * without booting fastify.
 *
 * Contracts pinned here:
 *   1. Happy path: valid UUID + new scope -> row updates,
 *      cross_session_injection_log gets a row with
 *      caller_label='brainstorm-scope-patch' and the old + new
 *      scope encoded as JSON in reject_reason.
 *   2. Null body clears the scope back to NULL (operator-initiated
 *      scope removal).
 *   3. Unknown id -> 404 {ok:false, error:'brainstorm not found'}.
 *   4. Bad shape: missing field returns 400 (so a typo cannot
 *      accidentally no-op the patch).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { IndexDb, type BrainstormSessionRow } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { patchBrainstormProjectScope } from '../src/dashboard/routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

const VALID_UUID_A = '11111111-2222-3333-4444-555555555555';
const VALID_UUID_B = '99999999-8888-7777-6666-555555555555';
const VALID_UUID_MISSING = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let tmpDir: string;
let dbFile: string;
let db: IndexDb;

function baseRow(id: string, scope: string | null = null): BrainstormSessionRow {
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
    project_scope_id: scope,
  };
}

function readAuditRows(): {
  caller_label: string | null;
  target_session: string;
  decision: string;
  reject_reason: string | null;
  brainstorm_id: string | null;
}[] {
  const raw = new Database(dbFile);
  try {
    return raw
      .prepare(
        `SELECT caller_label, target_session, decision, reject_reason, brainstorm_id
           FROM cross_session_injection_log
          WHERE caller_label = 'brainstorm-scope-patch'
          ORDER BY ts ASC`,
      )
      .all() as {
      caller_label: string | null;
      target_session: string;
      decision: string;
      reject_reason: string | null;
      brainstorm_id: string | null;
    }[];
  } finally {
    raw.close();
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-scope-patch-'));
  dbFile = path.join(tmpDir, 'index.db');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('patchBrainstormProjectScope - happy paths', () => {
  it('updates the row, writes an audit entry, and returns the transition', async () => {
    db.insertBrainstorm(baseRow(VALID_UUID_A, 'scope-old'));
    const res = await patchBrainstormProjectScope(db, VALID_UUID_A, {
      project_scope_id: 'scope-new',
    });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.brainstorm_id).toBe(VALID_UUID_A);
    expect(res.project_scope_id).toBe('scope-new');
    expect(res.old_scope).toBe('scope-old');
    /* Row actually flipped */
    expect(db.getBrainstorm(VALID_UUID_A)?.project_scope_id).toBe('scope-new');
    /* Audit row landed with caller_label + brainstorm_id + JSON
     * transition in reject_reason. */
    const rows = readAuditRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.caller_label).toBe('brainstorm-scope-patch');
    expect(rows[0]!.target_session).toBe(VALID_UUID_A);
    expect(rows[0]!.decision).toBe('accepted');
    expect(rows[0]!.brainstorm_id).toBe(VALID_UUID_A);
    const reason = JSON.parse(rows[0]!.reject_reason ?? '{}') as {
      old_scope: string | null;
      new_scope: string | null;
    };
    expect(reason).toEqual({ old_scope: 'scope-old', new_scope: 'scope-new' });
  });

  it('clears the scope back to NULL when body.project_scope_id is null', async () => {
    db.insertBrainstorm(baseRow(VALID_UUID_B, 'scope-was'));
    const res = await patchBrainstormProjectScope(db, VALID_UUID_B, {
      project_scope_id: null,
    });
    expect(res.status).toBe(200);
    expect(res.project_scope_id).toBeNull();
    expect(db.getBrainstorm(VALID_UUID_B)?.project_scope_id).toBeNull();
    const rows = readAuditRows();
    expect(rows.length).toBe(1);
    const reason = JSON.parse(rows[0]!.reject_reason ?? '{}') as {
      old_scope: string | null;
      new_scope: string | null;
    };
    expect(reason).toEqual({ old_scope: 'scope-was', new_scope: null });
  });
});

describe('patchBrainstormProjectScope - error paths', () => {
  it('returns 404 when no brainstorm row matches the id', async () => {
    const res = await patchBrainstormProjectScope(db, VALID_UUID_MISSING, {
      project_scope_id: 'whatever',
    });
    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('brainstorm not found');
    /* No audit row written for failed lookups. */
    expect(readAuditRows().length).toBe(0);
  });

  it('returns 400 when the id is not uuid-shaped', async () => {
    const res = await patchBrainstormProjectScope(db, 'not-a-uuid', {
      project_scope_id: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/uuid/i);
    expect(readAuditRows().length).toBe(0);
  });

  it('returns 400 when project_scope_id field is missing from the body', async () => {
    db.insertBrainstorm(baseRow(VALID_UUID_A, null));
    const res = await patchBrainstormProjectScope(db, VALID_UUID_A, {});
    expect(res.status).toBe(400);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/required/i);
    expect(readAuditRows().length).toBe(0);
  });
});
