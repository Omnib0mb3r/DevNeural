import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-cur-'));
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

describe('curator instrumentation (CI-1, CI-2, CI-5, CI-6)', () => {
  it('insertCuratorLog persists an inject row with confidence', () => {
    db.insertCuratorLog({
      id: 'log-1',
      prompt_id: 'p-1',
      session_id: 's-1',
      project_slug: 'proj-a',
      decision: 'inject',
      page_slug: 'connection-pooling',
      score: 0.75,
      threshold: 0.55,
      confidence: 0.44,
      source_class: 'wiki',
    });
    const raw = new Database(dbFile);
    try {
      const row = raw
        .prepare(`SELECT * FROM curator_log WHERE id = ?`)
        .get('log-1') as Record<string, unknown>;
      expect(row.decision).toBe('inject');
      expect(row.page_slug).toBe('connection-pooling');
      expect(row.confidence).toBeCloseTo(0.44, 4);
      expect(row.source_class).toBe('wiki');
    } finally {
      raw.close();
    }
  });

  it('insertCuratorLog rejects duplicate prompt_id', () => {
    db.insertCuratorLog({
      id: 'log-1',
      prompt_id: 'p-dup',
      session_id: 's-1',
      project_slug: 'proj-a',
      decision: 'inject',
      page_slug: 'a',
      score: 0.7,
      threshold: 0.55,
      confidence: 0.3,
      source_class: 'wiki',
    });
    expect(() =>
      db.insertCuratorLog({
        id: 'log-2',
        prompt_id: 'p-dup',
        session_id: 's-1',
        project_slug: 'proj-a',
        decision: 'silence',
        page_slug: null,
        score: null,
        threshold: 0.55,
        confidence: null,
        source_class: null,
      }),
    ).toThrow(/UNIQUE/);
  });

  it('insertCuratorSignal records a hit referencing curator_log', () => {
    db.insertCuratorLog({
      id: 'log-h',
      prompt_id: 'p-h',
      session_id: 's',
      project_slug: 'p',
      decision: 'inject',
      page_slug: 'a',
      score: 0.8,
      threshold: 0.55,
      confidence: 0.55,
      source_class: 'wiki',
    });
    db.insertCuratorSignal({
      id: 'sig-h',
      curator_log_id: 'log-h',
      prompt_id: 'p-h',
      signal: 'hit',
      source: 'regex-inferred',
      weight: 1.0,
    });
    const raw = new Database(dbFile);
    try {
      const sig = raw
        .prepare(`SELECT * FROM curator_signal WHERE id = ?`)
        .get('sig-h') as Record<string, unknown>;
      expect(sig.signal).toBe('hit');
      expect(sig.weight).toBe(1.0);
    } finally {
      raw.close();
    }
  });

  it('curatorHealthWindow aggregates totals correctly', () => {
    db.insertCuratorLog({
      id: 'l1',
      prompt_id: 'p1',
      session_id: 's',
      project_slug: 'p',
      decision: 'inject',
      page_slug: 'a',
      score: 0.7,
      threshold: 0.55,
      confidence: 0.3,
      source_class: 'wiki',
    });
    db.insertCuratorLog({
      id: 'l2',
      prompt_id: 'p2',
      session_id: 's',
      project_slug: 'p',
      decision: 'silence',
      page_slug: null,
      score: null,
      threshold: 0.55,
      confidence: null,
      source_class: null,
    });
    db.insertCuratorSignal({
      id: 'sg1',
      curator_log_id: 'l1',
      prompt_id: 'p1',
      signal: 'click',
      source: 'dashboard-click',
      weight: 1.0,
    });
    const w = db.curatorHealthWindow(7);
    expect(w.inject_total).toBe(1);
    expect(w.silence_total).toBe(1);
    expect(w.click_total).toBe(1);
    expect(w.hit_total).toBe(0);
  });
});
