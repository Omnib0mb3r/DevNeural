import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { cullRawChunks } from '../src/reinforcement/raw-chunks-cull.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
/* Minimal Store-shaped stub. cullRawChunks only reaches into
 * store.db (for the better-sqlite3 handle) and store.rawChunks
 * (for the optional vector delete). Avoids Store.open which
 * imports paths.ts; paths.ts captures DEVNEURAL_DATA_ROOT at
 * MODULE LOAD time, so a Store.open() call from this test would
 * point at the cached value (production data root for the first
 * test in the run) instead of tmpDir, polluting live data. */
let stubStore: { db: IndexDb; rawChunks: { delete?: (id: string) => Promise<void> } };
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-cull-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  /* Bootstrap legacy IndexDb tables, then run migrations, then
   * keep an open IndexDb handle for upsertRawChunk during the
   * test. */
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  stubStore = { db, rawChunks: {} };
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertRaw(opts: {
  id: string;
  ageDays: number;
  kind?: string;
}): void {
  db.upsertRawChunk({
    id: opts.id,
    project_id: 'proj-cull',
    session_id: 'sess-cull',
    timestamp_ms: Date.now() - opts.ageDays * 24 * 60 * 60 * 1000,
    kind: opts.kind ?? 'transcript',
    role: 'user',
    byte_length: 100,
  });
}

describe('raw chunks cull (OP-4)', () => {
  it('archives chunks older than ageDays AND not brainstorm-summary AND not referenced', async () => {
    insertRaw({ id: 'old-1', ageDays: 200 });
    insertRaw({ id: 'old-2', ageDays: 200 });
    insertRaw({ id: 'recent', ageDays: 30 });
    insertRaw({ id: 'old-summary', ageDays: 200, kind: 'brainstorm-summary' });

    const result = await cullRawChunks(stubStore as never, {
      ageDays: 180,
      reinforcementLogPath: path.join(tmpDir, 'reinforcement.log.jsonl'),
    });

    expect(result.scanned).toBe(3); // recent excluded by age filter
    expect(result.archived).toBe(2);
    expect(result.skipped_brainstorm_summary).toBe(1);
    expect(result.skipped_referenced).toBe(0);

    const raw = new Database(dbFile);
    try {
      const remaining = raw
        .prepare(`SELECT id FROM raw_chunks_meta ORDER BY id`)
        .all() as { id: string }[];
      const archived = raw
        .prepare(`SELECT id FROM raw_chunks_archived ORDER BY id`)
        .all() as { id: string }[];
      expect(remaining.map((r) => r.id).sort()).toEqual([
        'old-summary',
        'recent',
      ]);
      expect(archived.map((r) => r.id).sort()).toEqual(['old-1', 'old-2']);
    } finally {
      raw.close();
    }
  });

  it('skips chunks that have at least one reinforcement-log reference', async () => {
    insertRaw({ id: 'old-referenced', ageDays: 200 });
    insertRaw({ id: 'old-unused', ageDays: 200 });
    const logPath = path.join(tmpDir, 'reinforcement.log.jsonl');
    fs.writeFileSync(
      logPath,
      JSON.stringify({ kind: 'injection', source: 'raw', chunk: 'old-referenced' }) + '\n',
      'utf8',
    );

    const result = await cullRawChunks(stubStore as never, {
      ageDays: 180,
      reinforcementLogPath: logPath,
    });

    expect(result.archived).toBe(1);
    expect(result.skipped_referenced).toBe(1);

    const raw = new Database(dbFile);
    try {
      const remaining = raw
        .prepare(`SELECT id FROM raw_chunks_meta ORDER BY id`)
        .all() as { id: string }[];
      expect(remaining.map((r) => r.id)).toEqual(['old-referenced']);
    } finally {
      raw.close();
    }
  });

  it('does not touch brainstorm_chunks table (separate from raw_chunks_meta)', async () => {
    /* Insert a parent brainstorm_sessions row first to satisfy
     * the FK from brainstorm_chunks. Then insert one
     * brainstorm_chunks row directly via raw SQL since IndexDb has
     * no helper for it yet. The cull job operates on
     * raw_chunks_meta only; the brainstorm_chunks row must
     * survive regardless of age. */
    db.insertBrainstorm({
      id: 'bs-x',
      claude_session_id: null,
      pty_id: null,
      cwd: tmpDir,
      user_label: 'parent',
      derived_label: null,
      mode: 'conversation',
      status: 'active',
      started_ms: Date.now(),
      ended_ms: null,
      turn_count: 0,
      topic_tags_json: '[]',
      artifacts_json: '{}',
      last_summary: null,
      last_summary_ms: null,
    });
    const raw = new Database(dbFile);
    try {
      raw.pragma('foreign_keys = ON');
      raw.prepare(
        `INSERT INTO brainstorm_chunks
           (id, brainstorm_id, turn_index, role, mode, text, model_id, no_decay)
         VALUES ('bc-old', 'bs-x', 0, 'user', 'conversation', 'old text', 'm', 1)`,
      ).run();
    } finally {
      raw.close();
    }

    insertRaw({ id: 'old-x', ageDays: 200 });
    await cullRawChunks(stubStore as never, {
      ageDays: 180,
      reinforcementLogPath: path.join(tmpDir, 'reinforcement.log.jsonl'),
    });

    const raw2 = new Database(dbFile);
    try {
      const bc = raw2
        .prepare(`SELECT COUNT(*) as n FROM brainstorm_chunks`)
        .get() as { n: number };
      expect(bc.n).toBe(1);
      const meta = raw2
        .prepare(`SELECT COUNT(*) as n FROM raw_chunks_meta`)
        .get() as { n: number };
      // old-x archived; raw_chunks_meta should be empty for this scenario.
      expect(meta.n).toBe(0);
    } finally {
      raw2.close();
    }
  });
});
