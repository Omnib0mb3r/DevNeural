/**
 * Meeting-notes fixes (2026-07), task 1 (F1): writeThroughBrainstormRow
 * kind threading. This is the legacy-row mirror spawnLexSession calls
 * after a cc-pty anchor spawns; before this fix it hardcoded every
 * fresh row's kind to the SQLite default ('brainstorm'), so a cc-pty
 * anchor could never land as a meeting. Exported (like prepareLexSpawn)
 * because it never touches pty-host, so no real PTY subprocess is
 * needed to exercise it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore } from '../src/lex/brainstorm-store.js';
import {
  prepareLexSpawn,
  writeThroughBrainstormRow,
} from '../src/lex/spawn-lex-session.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');
const CWD = 'C:/dev/data/skill-connections/brainstorm';
const FAKE_HOME = 'C:/Users/fake';

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-spawn-kind-'));
  dbFile = path.join(tmpDir, 'index.db');
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

describe('writeThroughBrainstormRow kind threading (fresh anchor)', () => {
  it('lands kind=meeting on the legacy row when explicitly requested', () => {
    const prep = prepareLexSpawn({
      cwd: CWD,
      homeDir: FAKE_HOME,
      ccSessionId: '11111111-1111-1111-1111-111111111111',
    });
    writeThroughBrainstormRow({
      lexSession: prep.lexSession,
      ccSessionId: prep.ccSessionId,
      ptyId: 'pty-fake-1',
      kind: 'meeting',
    });
    const row = db.getBrainstorm(prep.lexSession.id);
    expect(row).toBeTruthy();
    expect(row?.kind).toBe('meeting');
  });

  it('default off-mode path (kind omitted) is unaffected: row stays kind=brainstorm', () => {
    const prep = prepareLexSpawn({
      cwd: CWD,
      homeDir: FAKE_HOME,
      ccSessionId: '22222222-2222-2222-2222-222222222222',
    });
    writeThroughBrainstormRow({
      lexSession: prep.lexSession,
      ccSessionId: prep.ccSessionId,
      ptyId: 'pty-fake-2',
    });
    const row = db.getBrainstorm(prep.lexSession.id);
    expect(row?.kind ?? 'brainstorm').toBe('brainstorm');
  });
});

describe('writeThroughBrainstormRow kind threading (reopen)', () => {
  it('does not reclassify an existing row on reopen even if kind is passed', () => {
    const prep = prepareLexSpawn({
      cwd: CWD,
      homeDir: FAKE_HOME,
      ccSessionId: '33333333-3333-3333-3333-333333333333',
    });
    writeThroughBrainstormRow({
      lexSession: prep.lexSession,
      ccSessionId: prep.ccSessionId,
      ptyId: 'pty-fake-3',
      kind: 'meeting',
    });
    expect(db.getBrainstorm(prep.lexSession.id)?.kind).toBe('meeting');

    /* Reopen: same anchor, new cc session. Passing kind='brainstorm'
     * here must NOT flip the already-classified meeting row -- the
     * reopen branch returns before touching kind at all. */
    const reopenPrep = prepareLexSpawn({
      lexSessionId: prep.lexSession.id,
      ccSessionId: '44444444-4444-4444-4444-444444444444',
      homeDir: FAKE_HOME,
    });
    writeThroughBrainstormRow({
      lexSession: reopenPrep.lexSession,
      ccSessionId: reopenPrep.ccSessionId,
      ptyId: 'pty-fake-4',
      kind: 'brainstorm',
    });
    expect(db.getBrainstorm(prep.lexSession.id)?.kind).toBe('meeting');
  });
});
