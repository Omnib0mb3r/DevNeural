/**
 * Context gauge fields on the Stream Deck anchor tile (2026-09-22 plan,
 * Task 10). Integration pin over a real temp IndexDb: listAnchorTiles
 * resolves the supervised worker's cwd + current session id, derives
 * both context percentages from the two jsonl tails, and carries the
 * smart-clear trip marks (threshold + ceiling) from runtime_config so
 * every gauge on the dashboard draws the same two lines.
 *
 * Scope fail-closed: an unbound anchor reports worker_ctx_pct null;
 * nothing from another anchor's worker ever lands on it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore as setBrainstormStore } from '../src/lex/brainstorm-store.js';
import { appendTranscriptRef } from '../src/lex/lex-session-store.js';
import { transcriptPathFor } from '../src/lex/spawn-lex-session.js';
import { deriveContextFromTail } from '../src/dashboard/sessions.js';
import { listAnchorTiles } from '../src/lex/anchor-tiles.js';
import {
  SMART_CLEAR_CEILING_KEY,
  SMART_CLEAR_THRESHOLD_KEY,
} from '../src/lex/smart-clear.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let homeDir: string;
let priorRoot: string | undefined;
let priorUserprofile: string | undefined;
let priorHome: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-tiles-ctx-'));
  homeDir = path.join(tmpDir, 'home');
  fs.mkdirSync(path.join(homeDir, '.claude', 'projects'), { recursive: true });
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

/* One assistant record whose usage sums to `tokens` context tokens. */
function writeUsageJsonl(file: string, tokens: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const usage = {
    input_tokens: tokens - 1_000,
    cache_creation_input_tokens: 500,
    cache_read_input_tokens: 500,
    output_tokens: 12,
  };
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'summary', summary: 'x' }) +
      '\n' +
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage },
      }) +
      '\n',
    'utf8',
  );
}

function pctOf(file: string): number {
  const ctx = deriveContextFromTail(file);
  if (!ctx) throw new Error(`no usage in ${file}`);
  return Math.round((ctx.tokens / ctx.max) * 100);
}

describe('listAnchorTiles context gauge fields', () => {
  it('carries worker + Lex pct and the smart-clear trip marks on a bound live anchor', () => {
    const workerCwd = 'C:/dev/Projects/foo';
    db.insertProjectSession({
      id: 'proj-1',
      project_slug: 'foo',
      cwd: workerCwd,
      title: 'foo',
      status: 'live',
      current_session_id: 'cc-worker-1',
      current_bridge_id: 'b-1',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 100,
    });
    db.insertLexSession({
      id: 'lex-1',
      created_ms: 1,
      title: 'bound',
      derived_title: null,
      status: 'live',
      current_pty_id: 'pty-live-1',
      cwd: 'C:/dev/data/brainstorm',
      supervises_project_anchor_id: 'proj-1',
    });
    const lexJsonl = path
      .join(homeDir, '.claude', 'projects', 'C--dev-data-brainstorm', 'cc-lex-1.jsonl')
      .replace(/\\/g, '/');
    appendTranscriptRef({
      lexSessionId: 'lex-1',
      ccSessionId: 'cc-lex-1',
      transcriptPath: lexJsonl,
      startedMs: 10,
    });
    writeUsageJsonl(lexJsonl, 250_000);
    const workerJsonl = transcriptPathFor({
      cwd: workerCwd,
      ccSessionId: 'cc-worker-1',
    });
    writeUsageJsonl(workerJsonl, 420_000);
    db.setRuntimeConfig(SMART_CLEAR_THRESHOLD_KEY, '35');
    db.setRuntimeConfig(SMART_CLEAR_CEILING_KEY, '70');

    const tiles = listAnchorTiles(
      (id) => db.getProjectSession(id)?.project_slug ?? null,
      (id) => db.getProjectSession(id)?.current_session_id ?? null,
      { livePtyIds: new Set(['pty-live-1']) },
    );
    expect(tiles).toHaveLength(1);
    const tile = tiles[0]!;
    expect(tile.anchor_id).toBe('lex-1');
    expect(tile.supervised_worker_session_id).toBe('cc-worker-1');
    expect(tile.worker_ctx_pct).toBe(pctOf(workerJsonl));
    expect(tile.lex_ctx_pct).toBe(pctOf(lexJsonl));
    expect(tile.ctx_threshold_pct).toBe(35);
    expect(tile.ctx_ceiling_pct).toBe(70);
  });

  it('reports worker_ctx_pct null on an unbound anchor and the default marks when unset', () => {
    db.insertLexSession({
      id: 'lex-2',
      created_ms: 1,
      title: 'unbound',
      derived_title: null,
      status: 'live',
      current_pty_id: 'pty-live-2',
      cwd: 'C:/dev/data/brainstorm',
      supervises_project_anchor_id: null,
    });
    const tiles = listAnchorTiles(
      () => null,
      () => null,
      { livePtyIds: new Set(['pty-live-2']) },
    );
    expect(tiles).toHaveLength(1);
    const tile = tiles[0]!;
    expect(tile.worker_ctx_pct).toBeNull();
    /* No transcript ref yet: Lex's own pct is unknown, not 0. */
    expect(tile.lex_ctx_pct).toBeNull();
    expect(tile.ctx_threshold_pct).toBe(40);
    expect(tile.ctx_ceiling_pct).toBe(60);
  });
});
