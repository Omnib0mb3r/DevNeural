/**
 * LEX-AUTONOMY codex 12d (Fix 49 full closure): project_scope_id
 * regression matrix.
 *
 * Single source of truth for the scope-vs-label predicate now that
 * all three Fix 49 code paths have shipped:
 *   - codex 12 (dc26f88)  preloadSiblingDistillations prefers scope
 *   - codex 12a (ecab2d8) buildLabelMatchBlock mirrors the predicate
 *   - codex 12b (20419a8) PATCH /brainstorms/:id/project-scope
 *   - codex 12c (b189956) insertBrainstorm inherits from lex_session
 *
 * The earlier per-feature test files
 * (`brainstorm-project-scope-inheritance.test.ts`,
 * `sibling-index.test.ts`) still pin each module's contract; this
 * file ties the four code paths together so a regression in any one
 * lights up here even if a feature owner forgets to refresh their
 * focused suite.
 *
 * Eleven pins:
 *   1-4 preloadSiblingDistillations matrix (scope wins, label
 *       fallback, scope precedence over divergent labels, inverse
 *       fallback when candidate scope is null).
 *   5-8 buildLabelMatchBlock matrix (same four cases against the
 *       label-match block used by the cold-start preload route).
 *   9-10 migration 044 backfill behaviour (bound lex_session.
 *       supervises copies through; unbound stays NULL).
 *   11 insert-path inheritance (codex 12c regression-locus).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { IndexDb, type BrainstormSessionRow } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildSiblingIndex } from '../src/lex/sibling-index.js';
import { preloadSiblingDistillations } from '../src/lex/sibling-distillation-preload.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;

function row(opts: {
  id: string;
  user_label: string | null;
  started_ms: number;
  project_scope_id?: string | null;
  last_summary?: string | null;
}): BrainstormSessionRow {
  return {
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/p/lex',
    user_label: opts.user_label,
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: opts.started_ms,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: opts.last_summary ?? null,
    last_summary_ms: null,
    project_scope_id: opts.project_scope_id ?? null,
  };
}

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

function seedProjectAnchor(id: string): void {
  db.insertProjectSession({
    id,
    project_slug: id,
    cwd: `C:/p/${id}`,
    title: null,
    status: 'live',
    current_session_id: 'cc-live',
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1_000,
    last_seen_ms: 1_000,
  });
}

async function nullGenerator(): Promise<string | null> {
  return null;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-scope-matrix-'));
  dbFile = path.join(tmpDir, 'index.db');
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
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('preloadSiblingDistillations scope-vs-label matrix', () => {
  it('pin 1: groups by scope when both sides have non-null scope, ignoring label divergence', async () => {
    db.insertBrainstorm(
      row({
        id: 'sib-a',
        user_label: 'Label X',
        started_ms: 5_000,
        project_scope_id: 'scope-S',
        last_summary: 'sib a summary',
      }),
    );
    db.insertBrainstorm(
      row({
        id: 'sib-b',
        user_label: 'Label Y',
        started_ms: 4_000,
        project_scope_id: 'scope-S',
        last_summary: 'sib b summary',
      }),
    );
    db.insertBrainstorm(
      row({
        id: 'sib-noise',
        user_label: 'Label X',
        started_ms: 3_000,
        project_scope_id: 'scope-OTHER',
        last_summary: 'noise',
      }),
    );
    const res = await preloadSiblingDistillations({
      db,
      label: 'Label X',
      excludeId: null,
      generator: nullGenerator,
      projectScopeId: 'scope-S',
    });
    expect(new Set(res.already_present)).toEqual(new Set(['sib-a', 'sib-b']));
    expect(res.already_present).not.toContain('sib-noise');
  });

  it('pin 2: label fallback fires when both active and candidate carry null scope', async () => {
    db.insertBrainstorm(
      row({
        id: 'sib-c',
        user_label: 'Label Z',
        started_ms: 5_000,
        project_scope_id: null,
        last_summary: 'c summary',
      }),
    );
    db.insertBrainstorm(
      row({
        id: 'sib-d',
        user_label: 'Label Z',
        started_ms: 4_000,
        project_scope_id: null,
        last_summary: 'd summary',
      }),
    );
    const res = await preloadSiblingDistillations({
      db,
      label: 'Label Z',
      excludeId: null,
      generator: nullGenerator,
      projectScopeId: null,
    });
    expect(new Set(res.already_present)).toEqual(new Set(['sib-c', 'sib-d']));
  });

  it('pin 3: precedence - scope set on both sides AND labels differ, scope still wins', async () => {
    db.insertBrainstorm(
      row({
        id: 'sib-e',
        user_label: 'Foo',
        started_ms: 5_000,
        project_scope_id: 'scope-W',
        last_summary: 'e',
      }),
    );
    db.insertBrainstorm(
      row({
        id: 'sib-noise2',
        user_label: 'Active Label',
        started_ms: 4_000,
        project_scope_id: 'scope-other',
        last_summary: 'noise2',
      }),
    );
    const res = await preloadSiblingDistillations({
      db,
      label: 'Active Label',
      excludeId: null,
      generator: nullGenerator,
      projectScopeId: 'scope-W',
    });
    expect(res.already_present).toContain('sib-e');
    expect(res.already_present).not.toContain('sib-noise2');
  });

  it('pin 4: precedence inverse - candidate scope NULL, label match still fires (legacy compat)', async () => {
    db.insertBrainstorm(
      row({
        id: 'sib-f',
        user_label: 'Shared Label',
        started_ms: 5_000,
        project_scope_id: null,
        last_summary: 'f',
      }),
    );
    const res = await preloadSiblingDistillations({
      db,
      label: 'Shared Label',
      excludeId: null,
      generator: nullGenerator,
      projectScopeId: 'scope-active',
    });
    expect(res.already_present).toContain('sib-f');
  });
});

describe('buildLabelMatchBlock scope-vs-label matrix', () => {
  /* These pins use the label-match block (no anchorId; no transcript
   * refs). The block is the second resolution path in buildSiblingIndex
   * and the one the cold-start preload route wires into the prompt. */
  it('pin 5: groups by scope when both sides have non-null scope, ignoring label divergence', () => {
    db.insertBrainstorm(
      row({
        id: 'lm-a',
        user_label: 'Label A',
        started_ms: 5_000,
        project_scope_id: 'sl-1',
        last_summary: 'a',
      }),
    );
    db.insertBrainstorm(
      row({
        id: 'lm-b',
        user_label: 'Label B',
        started_ms: 4_000,
        project_scope_id: 'sl-1',
        last_summary: 'b',
      }),
    );
    db.insertBrainstorm(
      row({
        id: 'lm-noise',
        user_label: 'Label A',
        started_ms: 3_000,
        project_scope_id: 'sl-other',
      }),
    );
    const out = buildSiblingIndex({
      db,
      label: 'Label A',
      projectScopeId: 'sl-1',
    });
    expect(out).toMatch(/^# Sibling sessions \(same project scope sl-1\)/);
    expect(out).toMatch(/- lm-a/);
    expect(out).toMatch(/- lm-b/);
    expect(out).not.toMatch(/- lm-noise/);
  });

  it('pin 6: label fallback fires when active + candidate carry null scope', () => {
    db.insertBrainstorm(
      row({
        id: 'lm-c',
        user_label: 'Pure Label',
        started_ms: 5_000,
        project_scope_id: null,
        last_summary: 'c',
      }),
    );
    db.insertBrainstorm(
      row({
        id: 'lm-d',
        user_label: 'Pure Label',
        started_ms: 4_000,
        project_scope_id: null,
        last_summary: 'd',
      }),
    );
    const out = buildSiblingIndex({
      db,
      label: 'Pure Label',
      projectScopeId: null,
    });
    expect(out).toMatch(/^# Sibling sessions \(same label "Pure Label"\)/);
    expect(out).toMatch(/- lm-c/);
    expect(out).toMatch(/- lm-d/);
  });

  it('pin 7: precedence - scope set both sides, labels diverge, scope wins', () => {
    db.insertBrainstorm(
      row({
        id: 'lm-e',
        user_label: 'Foo',
        started_ms: 5_000,
        project_scope_id: 'priority-scope',
        last_summary: 'e',
      }),
    );
    db.insertBrainstorm(
      row({
        id: 'lm-noise2',
        user_label: 'Active Label',
        started_ms: 4_000,
        project_scope_id: 'wrong-scope',
        last_summary: 'noise',
      }),
    );
    const out = buildSiblingIndex({
      db,
      label: 'Active Label',
      projectScopeId: 'priority-scope',
    });
    expect(out).toMatch(/- lm-e/);
    expect(out).not.toMatch(/- lm-noise2/);
  });

  it('pin 8: precedence inverse - candidate scope NULL, label match still fires', () => {
    db.insertBrainstorm(
      row({
        id: 'lm-f',
        user_label: 'Shared',
        started_ms: 5_000,
        project_scope_id: null,
        last_summary: 'f',
      }),
    );
    const out = buildSiblingIndex({
      db,
      label: 'Shared',
      projectScopeId: 'active-scope',
    });
    /* Header reports scope grouping because the active anchor carries
     * one; the matching row still surfaces because the predicate
     * falls back to label when the candidate scope is null. */
    expect(out).toMatch(/^# Sibling sessions \(same project scope active-scope\)/);
    expect(out).toMatch(/- lm-f/);
  });
});

describe('migration 044 backfill behaviour', () => {
  function applyBackfillUpdate(): void {
    const sqlPath = path.resolve(
      MIGRATIONS_DIR,
      '044-brainstorm-project-scope-id.sql',
    );
    const raw = fs.readFileSync(sqlPath, 'utf-8');
    /* Strip the ALTER TABLE + CREATE INDEX statements - the column
     * and index already exist after runMigrations; re-running them
     * raises "duplicate column" / no-op. Keep the UPDATE statement
     * which is the idempotent backfill we want to drive. */
    const updateMatch = raw.match(/UPDATE brainstorm_sessions[\s\S]+?;\s*/);
    if (!updateMatch) {
      throw new Error('migration 044 UPDATE statement not found');
    }
    const raw2 = new Database(dbFile);
    try {
      raw2.exec(updateMatch[0]);
    } finally {
      raw2.close();
    }
  }

  it('pin 9: bound lex_session.supervises copies into project_scope_id for an unscoped brainstorm', () => {
    seedProjectAnchor('anchor-X');
    /* Insert brainstorm row BEFORE lex_session so the codex 12c
     * COALESCE subquery in insertBrainstorm sees no supervisor
     * binding and leaves project_scope_id NULL - this reproduces
     * the legacy pre-migration shape. */
    db.insertBrainstorm(row({ id: 'bs-pre', user_label: 'pre', started_ms: 1 }));
    insertLex('bs-pre', 'anchor-X');
    /* Sanity: row currently has no scope despite the bound lex
     * session. The migration UPDATE is the only thing that should
     * close the gap. */
    expect(db.getBrainstorm('bs-pre')?.project_scope_id ?? null).toBeNull();
    applyBackfillUpdate();
    expect(db.getBrainstorm('bs-pre')?.project_scope_id).toBe('anchor-X');
  });

  it('pin 10: unbound brainstorm (no lex_session, or supervises NULL) stays NULL after backfill', () => {
    /* Two variants. Row A has a lex_session with NULL supervises;
     * row B has no matching lex_session at all. Neither should get
     * touched by the backfill UPDATE. */
    db.insertBrainstorm(row({ id: 'bs-a', user_label: 'a', started_ms: 1 }));
    insertLex('bs-a', null);
    db.insertBrainstorm(row({ id: 'bs-b', user_label: 'b', started_ms: 1 }));
    applyBackfillUpdate();
    expect(db.getBrainstorm('bs-a')?.project_scope_id ?? null).toBeNull();
    expect(db.getBrainstorm('bs-b')?.project_scope_id ?? null).toBeNull();
  });
});

describe('insert-path inheritance regression locus', () => {
  it('pin 11: insertBrainstorm auto-copies lex_session.supervises when no explicit scope is supplied (codex 12c)', () => {
    seedProjectAnchor('proj-inherit');
    insertLex('bs-inh', 'proj-inherit');
    db.insertBrainstorm(row({ id: 'bs-inh', user_label: 'x', started_ms: 1 }));
    expect(db.getBrainstorm('bs-inh')?.project_scope_id).toBe('proj-inherit');
  });
});
