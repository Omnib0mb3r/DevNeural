/**
 * Worker-scoped buildVoiceSnapshot (bug: 2026-07-08 Lex sees all
 * workers). When a brainstorm anchor supervises a project anchor,
 * the per-turn <live_state> block must contain ONLY that worker and
 * ONLY the brainstorm's own row — never the global registry. A
 * brainstorm with no supervised worker sees no workers at all.
 * Unscoped calls (no scope option) keep the legacy global view for
 * non-brainstorm consumers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore as setBrainstormStore } from '../src/lex/brainstorm-store.js';
import {
  buildVoiceSnapshot,
  resolveLexScope,
  resolveLexScopeDetailed,
} from '../src/lex/snapshot-context.js';
import type { BrainstormSessionRow } from '../src/store/index-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;
let priorProjectsRoot: string | undefined;
let priorUserprofile: string | undefined;
let priorHome: string | undefined;

function brainstormRow(
  id: string,
  label: string,
  overrides: Partial<BrainstormSessionRow> = {},
): BrainstormSessionRow {
  return {
    id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/dev/data/x/brainstorm',
    user_label: label,
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
    ...overrides,
  } as BrainstormSessionRow;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-snapscope-'));
  dbFile = path.join(tmpDir, 'index.db');
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
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } }).db
    .prepare('DELETE FROM project_session')
    .run();
  setBrainstormStore({ db } as never);

  /* Two live workers. */
  db.insertProjectSession({
    id: 'proj-mha-0000-0000-000000000000',
    project_slug: 'Material-Handling-Academy',
    cwd: 'C:/dev/Projects/Material-Handling-Academy',
    title: null,
    status: 'live',
    current_session_id: 'cc-mha-11111111',
    current_bridge_id: 'b1',
    current_pty_id: null,
    created_ms: 1,
    last_seen_ms: 100,
  });
  db.insertProjectSession({
    id: 'proj-bridger-0000-0000-00000000',
    project_slug: 'bridger-base-camp',
    cwd: 'C:/dev/Projects/bridger-base-camp',
    title: null,
    status: 'live',
    current_session_id: 'cc-bridger-2222',
    current_bridge_id: 'b1',
    current_pty_id: null,
    created_ms: 1,
    last_seen_ms: 100,
  });

  /* Two active brainstorms; "bs-mha" supervises the MHA worker. */
  db.insertLexSession({
    id: 'bs-mha',
    created_ms: 1,
    title: 'MHA Brainstorm',
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/data/x/brainstorm',
    supervises_project_anchor_id: 'proj-mha-0000-0000-000000000000',
  });
  db.insertBrainstorm(brainstormRow('bs-mha', 'MHA Brainstorm'));
  db.insertLexSession({
    id: 'bs-bridger',
    created_ms: 2,
    title: 'Bridger Brainstorm',
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/data/x/brainstorm',
    supervises_project_anchor_id: 'proj-bridger-0000-0000-00000000',
  });
  db.insertBrainstorm(brainstormRow('bs-bridger', 'Bridger Brainstorm'));
});

afterEach(() => {
  db.close();
  const restore = (
    k:
      | 'USERPROFILE'
      | 'HOME'
      | 'DEVNEURAL_PROJECTS_ROOT'
      | 'DEVNEURAL_DATA_ROOT',
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

describe('buildVoiceSnapshot worker scope', () => {
  it('shows only the supervised worker in open_projects', () => {
    const snap = buildVoiceSnapshot({
      scope: {
        brainstormId: 'bs-mha',
        superviseProjectAnchorId: 'proj-mha-0000-0000-000000000000',
      },
    });
    expect(snap).toContain('Material-Handling-Academy');
    expect(snap).not.toContain('bridger-base-camp');
  });

  it('shows only the own brainstorm in active_brainstorms', () => {
    const snap = buildVoiceSnapshot({
      scope: {
        brainstormId: 'bs-mha',
        superviseProjectAnchorId: 'proj-mha-0000-0000-000000000000',
      },
    });
    expect(snap).toContain('MHA Brainstorm');
    expect(snap).not.toContain('Bridger Brainstorm');
  });

  it('names the scope contract in the block', () => {
    const snap = buildVoiceSnapshot({
      scope: {
        brainstormId: 'bs-mha',
        superviseProjectAnchorId: 'proj-mha-0000-0000-000000000000',
      },
    });
    expect(snap).toContain('scope=worker');
    expect(snap).toContain(
      'only worker this brainstorm may observe or control',
    );
  });

  it('renders worker offline instead of leaking other projects when the supervised anchor is dormant', () => {
    db.updateProjectSession('proj-mha-0000-0000-000000000000', {
      status: 'dormant',
    });
    const snap = buildVoiceSnapshot({
      scope: {
        brainstormId: 'bs-mha',
        superviseProjectAnchorId: 'proj-mha-0000-0000-000000000000',
      },
    });
    expect(snap).toContain('offline');
    expect(snap).toContain('Material-Handling-Academy');
    expect(snap).not.toContain('bridger-base-camp');
  });

  it('shows no workers at all for a brainstorm with no supervised anchor', () => {
    const snap = buildVoiceSnapshot({
      scope: { brainstormId: 'bs-mha', superviseProjectAnchorId: null },
    });
    expect(snap).not.toContain('Material-Handling-Academy');
    expect(snap).not.toContain('bridger-base-camp');
    expect(snap).toContain('no worker bound');
  });

  it('keeps the legacy global view when no scope is passed', () => {
    const snap = buildVoiceSnapshot();
    expect(snap).toContain('Material-Handling-Academy');
    expect(snap).toContain('bridger-base-camp');
    expect(snap).toContain('MHA Brainstorm');
    expect(snap).toContain('Bridger Brainstorm');
  });
});

describe('resolveLexScope', () => {
  it('resolves the supervises binding from lex_session', () => {
    const scope = resolveLexScope('bs-mha');
    expect(scope.brainstormId).toBe('bs-mha');
    expect(scope.superviseProjectAnchorId).toBe(
      'proj-mha-0000-0000-000000000000',
    );
  });

  it('falls back to the legacy brainstorm project_scope_id when the lex row has no supervises', () => {
    db.insertLexSession({
      id: 'bs-legacy',
      created_ms: 3,
      title: 'Legacy Scoped',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/dev/data/x/brainstorm',
      supervises_project_anchor_id: null,
    });
    db.insertBrainstorm(
      brainstormRow('bs-legacy', 'Legacy Scoped', {
        project_scope_id: 'proj-bridger-0000-0000-00000000',
      } as never),
    );
    const scope = resolveLexScope('bs-legacy');
    expect(scope.superviseProjectAnchorId).toBe(
      'proj-bridger-0000-0000-00000000',
    );
  });

  it('resolves to a no-worker scope for an unknown brainstorm id', () => {
    const scope = resolveLexScope('bs-ghost');
    expect(scope.superviseProjectAnchorId).toBeNull();
  });

  it('resolveLexScopeDetailed carries slug + worker session id', () => {
    const detailed = resolveLexScopeDetailed('bs-mha');
    expect(detailed.projectAnchorId).toBe('proj-mha-0000-0000-000000000000');
    expect(detailed.projectSlug).toBe('Material-Handling-Academy');
    expect(detailed.workerSessionId).toBe('cc-mha-11111111');
  });
});
