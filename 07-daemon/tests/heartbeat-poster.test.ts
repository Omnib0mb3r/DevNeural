import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { createHeartbeatPoster } from '../src/heartbeat/poster.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-hb-'));
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

describe('heartbeat poster (OP-1)', () => {
  it('returns "disabled" when no url is configured', async () => {
    const poster = createHeartbeatPoster({ url: '' });
    const status = await poster.tickOnce(db);
    expect(status).toBe('disabled');
  });

  it('writes posted then ack on a 200 response', async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      ({ ok: true, status: 200 } as unknown as Response);
    const poster = createHeartbeatPoster({
      url: 'http://watcher.invalid/heartbeat',
      fetchImpl,
    });
    const status = await poster.tickOnce(db);
    expect(status).toBe('posted-ok');
    const raw = new Database(dbFile);
    try {
      const rows = raw
        .prepare(`SELECT status, detail FROM heartbeat_log ORDER BY ts`)
        .all() as { status: string; detail: string }[];
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe('ack');
      expect(rows[0]!.detail).toContain('200');
    } finally {
      raw.close();
    }
  });

  it('writes no-ack on a 5xx', async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      ({ ok: false, status: 503 } as unknown as Response);
    const poster = createHeartbeatPoster({
      url: 'http://watcher.invalid/heartbeat',
      fetchImpl,
    });
    const status = await poster.tickOnce(db);
    expect(status).toBe('no-ack');
    const raw = new Database(dbFile);
    try {
      const row = raw
        .prepare(`SELECT status, detail FROM heartbeat_log ORDER BY ts DESC LIMIT 1`)
        .get() as { status: string; detail: string };
      expect(row.status).toBe('no-ack');
      expect(row.detail).toContain('503');
    } finally {
      raw.close();
    }
  });

  it('writes no-ack on network error', async () => {
    const fetchImpl: typeof globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const poster = createHeartbeatPoster({
      url: 'http://watcher.invalid/heartbeat',
      fetchImpl,
    });
    const status = await poster.tickOnce(db);
    expect(status).toBe('no-ack');
    const raw = new Database(dbFile);
    try {
      const row = raw
        .prepare(`SELECT status, detail FROM heartbeat_log ORDER BY ts DESC LIMIT 1`)
        .get() as { status: string; detail: string };
      expect(row.status).toBe('no-ack');
      expect(row.detail).toContain('ECONNREFUSED');
    } finally {
      raw.close();
    }
  });
});
