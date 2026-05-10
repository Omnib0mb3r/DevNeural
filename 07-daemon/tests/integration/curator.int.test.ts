/**
 * Curator-layer golden-path integration test (TC-1).
 *
 * End-to-end: a curator decision (inject or silence) writes a
 * curator_log row with the expected shape, and a follow-up signal
 * insert references the log row by FK without fault.
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

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-cur-int-'));
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

describe('curator.int (TC-1)', () => {
  it('inject + click round-trip: curator_log + curator_signal joined by FK', () => {
    db.insertCuratorLog({
      id: 'log-int-1',
      prompt_id: 'prompt-int-1',
      session_id: 'sess-int-1',
      project_slug: 'proj-int',
      decision: 'inject',
      page_slug: 'connection-pooling',
      score: 0.78,
      threshold: 0.55,
      confidence: 0.51,
      source_class: 'wiki',
    });
    db.insertCuratorSignal({
      id: 'sig-int-1',
      curator_log_id: 'log-int-1',
      prompt_id: 'prompt-int-1',
      signal: 'click',
      source: 'dashboard-click',
      weight: 1.0,
    });
    const raw = new Database(dbFile);
    try {
      const joined = raw
        .prepare(
          `SELECT cl.page_slug, cl.confidence, cs.signal
           FROM curator_log cl
           JOIN curator_signal cs ON cs.curator_log_id = cl.id
           WHERE cl.prompt_id = ?`,
        )
        .get('prompt-int-1') as Record<string, unknown>;
      expect(joined.page_slug).toBe('connection-pooling');
      expect(joined.confidence).toBeCloseTo(0.51, 4);
      expect(joined.signal).toBe('click');
    } finally {
      raw.close();
    }
  });

  it('curatorHealthWindow returns the inject + click totals after one round-trip', () => {
    db.insertCuratorLog({
      id: 'log-int-2',
      prompt_id: 'prompt-int-2',
      session_id: 'sess-int-2',
      project_slug: 'proj-int',
      decision: 'inject',
      page_slug: 'a',
      score: 0.7,
      threshold: 0.55,
      confidence: 0.33,
      source_class: 'wiki',
    });
    db.insertCuratorSignal({
      id: 'sig-int-2',
      curator_log_id: 'log-int-2',
      prompt_id: 'prompt-int-2',
      signal: 'hit',
      source: 'regex-inferred',
      weight: 1.0,
    });
    const w = db.curatorHealthWindow(7);
    expect(w.inject_total).toBe(1);
    expect(w.hit_total).toBe(1);
    expect(w.silence_total).toBe(0);
  });
});
