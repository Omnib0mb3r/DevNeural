/**
 * Meeting-notes fixes (2026-07), task 1 (F1): kind wiring on the live
 * creation paths. classifyBrainstormKind moved here from
 * wiki/backfill-brainstorms.ts (BF-14) so every creation path can
 * reuse the same mode->kind mapping the backfill always used, instead
 * of kind only ever being set retroactively. registerBrainstorm /
 * createStandaloneBrainstorm now accept an optional kind that wins
 * over the SQLite default; omitting it (the "off" / default path)
 * must leave the row exactly as before this change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  setStore,
  classifyBrainstormKind,
  registerBrainstorm,
  createStandaloneBrainstorm,
  setKind,
} from '../src/lex/brainstorm-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-kind-'));
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

describe('classifyBrainstormKind', () => {
  it("maps mode='notes' to 'meeting'", () => {
    expect(classifyBrainstormKind('notes')).toBe('meeting');
  });

  it("maps 'conversation', 'push-to-talk', and undefined to 'brainstorm'", () => {
    expect(classifyBrainstormKind('conversation')).toBe('brainstorm');
    expect(classifyBrainstormKind('push-to-talk')).toBe('brainstorm');
    expect(classifyBrainstormKind(undefined)).toBe('brainstorm');
  });
});

describe('registerBrainstorm kind wiring', () => {
  it('lands kind=meeting when explicitly requested', () => {
    const row = registerBrainstorm({
      ptyId: 'pty-1',
      cwd: '/tmp/brainstorm',
      startedMs: Date.now(),
      mode: 'notes',
      kind: 'meeting',
    });
    expect(row.kind).toBe('meeting');
    expect(db.getBrainstorm(row.id)?.kind).toBe('meeting');
  });

  it('default off-mode path (kind omitted) is unaffected: row stays kind=brainstorm', () => {
    const row = registerBrainstorm({
      ptyId: 'pty-2',
      cwd: '/tmp/brainstorm',
      startedMs: Date.now(),
      mode: 'conversation',
    });
    expect(row.kind ?? 'brainstorm').toBe('brainstorm');
    expect(db.getBrainstorm(row.id)?.kind ?? 'brainstorm').toBe('brainstorm');
  });
});

describe('createStandaloneBrainstorm kind wiring', () => {
  it('lands kind=meeting when explicitly requested', () => {
    const row = createStandaloneBrainstorm({
      mode: 'notes',
      kind: 'meeting',
    });
    expect(row.kind).toBe('meeting');
    expect(db.getBrainstorm(row.id)?.kind).toBe('meeting');
  });

  it('default off-mode path (kind omitted) is unaffected: row stays kind=brainstorm', () => {
    const row = createStandaloneBrainstorm({ mode: 'conversation' });
    expect(row.kind ?? 'brainstorm').toBe('brainstorm');
  });

  it('notes mode without the explicit kind flag does NOT silently become a meeting (explicit confirm, not auto-flip)', () => {
    /* CODEX-REVIEW-002.md:71: kind must never be inferred silently
     * from mode alone once the explicit-confirm toggle exists. */
    const row = createStandaloneBrainstorm({ mode: 'notes' });
    expect(row.kind ?? 'brainstorm').toBe('brainstorm');
  });
});

describe('setKind (explicit-confirm hello-time flip)', () => {
  it('flips an existing row from brainstorm to meeting and back', () => {
    const row = createStandaloneBrainstorm({ mode: 'notes' });
    expect(row.kind ?? 'brainstorm').toBe('brainstorm');

    const flipped = setKind(row.id, 'meeting');
    expect(flipped?.kind).toBe('meeting');
    expect(db.getBrainstorm(row.id)?.kind).toBe('meeting');

    const flippedBack = setKind(row.id, 'brainstorm');
    expect(flippedBack?.kind).toBe('brainstorm');
  });

  it('returns null for an unknown id', () => {
    expect(setKind('does-not-exist', 'meeting')).toBeNull();
  });
});
