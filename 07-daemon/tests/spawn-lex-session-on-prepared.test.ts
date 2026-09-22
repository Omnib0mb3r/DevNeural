/**
 * Voice layers (2026-09-21): spawnLexSession's onPrepared hook runs with
 * the prepared anchor BEFORE the L2 PTY spawns, so the anchor routes can
 * start Layer 1 (the voice brain) first. pty-host is mocked; no real
 * `claude` process is spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const { order } = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock('../src/dashboard/pty-host.js', () => ({
  spawnLex: vi.fn(() => {
    order.push('spawn');
    return { ptyId: 'pty-fake', pid: 4242 };
  }),
}));

import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore } from '../src/lex/brainstorm-store.js';
import { spawnLexSession } from '../src/lex/spawn-lex-session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  order.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-on-prepared-'));
  const dbFile = path.join(tmpDir, 'index.db');
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  setStore({ db });
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('spawnLexSession onPrepared', () => {
  it('runs with the prepared anchor before spawnLex', () => {
    const cwd = path.join(tmpDir, 'brainstorm').replace(/\\/g, '/');
    fs.mkdirSync(cwd, { recursive: true });
    let preparedId: string | null = null;
    const r = spawnLexSession({
      cwd,
      title: 'on-prepared',
      homeDir: 'C:/Users/fake',
      onPrepared: (prep) => {
        preparedId = prep.lexSession.id;
        order.push('prepared');
      },
    });
    expect(order).toEqual(['prepared', 'spawn']);
    expect(preparedId).toBe(r.lexSessionId);
    expect(r.ptyId).toBe('pty-fake');
  });

  it('a throwing onPrepared never blocks the L2 spawn', () => {
    const cwd = path.join(tmpDir, 'brainstorm2').replace(/\\/g, '/');
    fs.mkdirSync(cwd, { recursive: true });
    const r = spawnLexSession({
      cwd,
      title: 'throwing',
      homeDir: 'C:/Users/fake',
      onPrepared: () => {
        throw new Error('voice brain exploded');
      },
    });
    expect(order).toEqual(['spawn']);
    expect(r.ptyId).toBe('pty-fake');
  });
});
