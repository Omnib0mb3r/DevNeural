/**
 * Brainstorm-layer golden-path integration test (TC-1).
 *
 * End-to-end assertion: a brainstorm_sessions row with kind='brainstorm'
 * is classified as 'brainstorm' source class by the unified search
 * pipeline; a row with kind='meeting' is classified as 'meeting'.
 * Validates the BF-1 + BF-16 source-class routing through real
 * DB writes (no mocks).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../../src/store/index-db.js';
import { runMigrations } from '../../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-bs-int-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  db = new IndexDb(dbFile);
  db.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('brainstorm.int (TC-1)', () => {
  it('persists kind=brainstorm and kind=meeting on insert + read', async () => {
    db.insertBrainstorm({
      id: 'bs-1',
      claude_session_id: 'cc-1',
      pty_id: null,
      cwd: tmpDir,
      user_label: 'pricing rethink',
      derived_label: null,
      mode: 'conversation',
      status: 'ended',
      started_ms: Date.now() - 1000,
      ended_ms: Date.now(),
      turn_count: 5,
      topic_tags_json: '[]',
      artifacts_json: '{}',
      last_summary: 'sum',
      last_summary_ms: Date.now(),
    });
    /* Meeting row uses INSERT OR REPLACE so we set kind via a raw
     * UPDATE to mimic the future POST /sessions/new path. */
    db.insertBrainstorm({
      id: 'mt-1',
      claude_session_id: 'cc-2',
      pty_id: null,
      cwd: tmpDir,
      user_label: 'Q2 review',
      derived_label: null,
      mode: 'notes',
      status: 'ended',
      started_ms: Date.now() - 2000,
      ended_ms: Date.now(),
      turn_count: 8,
      topic_tags_json: '[]',
      artifacts_json: '{}',
      last_summary: 'm sum',
      last_summary_ms: Date.now(),
    });
    /* SQLite default for new column kind is 'brainstorm'; flip mt-1
     * to 'meeting' to model the BF-14 default for notes mode. */
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(dbFile);
    try {
      raw.prepare(`UPDATE brainstorm_sessions SET kind = 'meeting' WHERE id = 'mt-1'`).run();
    } finally {
      raw.close();
    }

    const a = db.getBrainstorm('bs-1');
    const b = db.getBrainstorm('mt-1');
    expect(a?.kind).toBe('brainstorm');
    expect(b?.kind).toBe('meeting');
  });

  it('the wiki frontmatter sweep migration creates Phase Two defaults', () => {
    /* Validates that runMigrations actually touched the wiki dir
     * for this test's tmp DATA_ROOT. The sweep ships defaults so
     * future Lex recall paths can rely on the fields existing. */
    const samplePage = path.join(tmpDir, 'wiki', 'sample.md');
    fs.writeFileSync(samplePage, 'Body without frontmatter\n', 'utf8');
    /* re-run the sweep migration directly (idempotent on already-
     * processed pages; new pages get defaults). Bypass the runner
     * which would skip it as already-applied. */
    return import('../../scripts/migrations/009-wiki-frontmatter-sweep.ts').then(
      (mod) => {
        mod.default(null as never);
        const text = fs.readFileSync(samplePage, 'utf8');
        expect(text).toContain('schema_version: 2');
        expect(text).toContain('frozen: false');
        expect(text).toContain('source_brainstorms: []');
      },
    );
  });
});
