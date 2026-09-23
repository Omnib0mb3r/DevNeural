/**
 * /sessions rows expose ctx_pct (2026-09-22 plan, Task 10).
 *
 * listSessions already tail-derives the context usage for live_state;
 * the dashboard's compact gauge on the sessions page needs the whole
 * percent on the row itself so every surface rounds the same way.
 * contextPct is the one rounding rule shared with the anchor tiles.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore as setBrainstormStore } from '../src/lex/brainstorm-store.js';
import { contextPct, listSessions } from '../src/dashboard/sessions.js';

describe('contextPct', () => {
  it('rounds to a whole percent of the context window', () => {
    expect(contextPct({ tokens: 420_000, max: 1_000_000 })).toBe(42);
    expect(contextPct({ tokens: 425_000, max: 1_000_000 })).toBe(43);
    expect(contextPct({ tokens: 0, max: 1_000_000 })).toBe(0);
  });

  it('clamps to 0..100', () => {
    expect(contextPct({ tokens: 1_500_000, max: 1_000_000 })).toBe(100);
    expect(contextPct({ tokens: -5, max: 100 })).toBe(0);
  });

  it('is null when usage is unknown or the window is unusable', () => {
    expect(contextPct(null)).toBeNull();
    expect(contextPct(undefined)).toBeNull();
    expect(contextPct({ tokens: 10, max: 0 })).toBeNull();
    expect(contextPct({ tokens: Number.NaN, max: 100 })).toBeNull();
  });
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let homeDir: string;
let claudeRoot: string;
let priorRoot: string | undefined;
let priorUserprofile: string | undefined;
let priorHome: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-sessions-ctx-'));
  homeDir = path.join(tmpDir, 'home');
  claudeRoot = path.join(homeDir, '.claude', 'projects');
  fs.mkdirSync(claudeRoot, { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  priorUserprofile = process.env.USERPROFILE;
  priorHome = process.env.HOME;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;
  const dbFile = path.join(tmpDir, 'index.db');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } }).db
    .prepare('DELETE FROM project_session')
    .run();
  setBrainstormStore({ db } as never);
});

afterEach(() => {
  db.close();
  const restore = (k: 'USERPROFILE' | 'HOME' | 'DEVNEURAL_DATA_ROOT', v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('USERPROFILE', priorUserprofile);
  restore('HOME', priorHome);
  restore('DEVNEURAL_DATA_ROOT', priorRoot);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('listSessions ctx_pct', () => {
  it('surfaces the whole-percent context usage next to the raw context object', () => {
    const cwd = 'C:/dev/Projects/ctx';
    const ccId = 'ffffffff-6666-6666-6666-666666666666';
    const slugDir = path.join(claudeRoot, 'c--dev-Projects-ctx');
    fs.mkdirSync(slugDir, { recursive: true });
    const tokens = 420_000;
    fs.writeFileSync(
      path.join(slugDir, `${ccId}.jsonl`),
      JSON.stringify({ type: 'summary', cwd, sessionId: ccId }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            usage: {
              input_tokens: tokens - 2_000,
              cache_creation_input_tokens: 1_000,
              cache_read_input_tokens: 1_000,
              output_tokens: 5,
            },
          },
        }) +
        '\n',
      'utf-8',
    );
    db.insertProjectSession({
      id: 'anchor-ctx',
      project_slug: 'ctx',
      cwd,
      title: 'ctx',
      status: 'live',
      current_session_id: ccId,
      current_bridge_id: 'b-ctx',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 100,
    });
    const row = listSessions().find((s) => s.session_id === ccId);
    expect(row).toBeDefined();
    expect(row!.context).not.toBeNull();
    expect(row!.context!.tokens).toBe(tokens);
    expect(row!.ctx_pct).toBe(
      Math.round((row!.context!.tokens / row!.context!.max) * 100),
    );
  });

  it('is null on a row whose jsonl has no usage record yet', () => {
    const cwd = 'C:/dev/Projects/fresh';
    const ccId = 'abababab-7777-7777-7777-777777777777';
    const slugDir = path.join(claudeRoot, 'c--dev-Projects-fresh');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, `${ccId}.jsonl`),
      JSON.stringify({ type: 'summary', cwd, sessionId: ccId }) + '\n',
      'utf-8',
    );
    db.insertProjectSession({
      id: 'anchor-fresh',
      project_slug: 'fresh',
      cwd,
      title: 'fresh',
      status: 'live',
      current_session_id: ccId,
      current_bridge_id: 'b-fresh',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 100,
    });
    const row = listSessions().find((s) => s.session_id === ccId);
    expect(row).toBeDefined();
    expect(row!.context).toBeNull();
    expect(row!.ctx_pct).toBeNull();
  });
});
