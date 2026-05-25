/**
 * Smart-compact scheduler tick.
 *
 * Drives runSmartCompactTick with stub evaluator + injector against a
 * tmp DB seeded with live anchors. Asserts: evaluator is called per
 * live anchor, action='wrap' drives fireSmartCompact (audit row
 * lands), action='wait' is recorded without an inject, action='fire'
 * is deferred to Lex (v2 - daemon no longer authors resume prompts),
 * errors do not abort the loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { runSmartCompactTick } from '../src/dashboard/smart-compact-scheduler.js';
import { recentSmartCompacts } from '../src/dashboard/smart-compact-routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-sched-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'Projects');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N = '0';
  process.env.DEVNEURAL_SMART_COMPACT_ENABLED = 'true';
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } })
    .db.prepare('DELETE FROM project_session')
    .run();
});

afterEach(() => {
  db.close();
  delete process.env.DEVNEURAL_SMART_COMPACT_SHADOW_N;
  delete process.env.DEVNEURAL_SMART_COMPACT_ENABLED;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedLive(id: string, pty: string | null = 'pty-' + id): void {
  db.insertProjectSession({
    id,
    project_slug: id,
    cwd: `C:/p/${id}`,
    title: id,
    status: 'live',
    current_session_id: 'cc-' + id,
    current_bridge_id: 'b-' + id,
    current_pty_id: pty,
    created_ms: 1,
    last_seen_ms: 1,
  });
}

describe('runSmartCompactTick', () => {
  it('evaluates every live anchor', async () => {
    seedLive('a');
    seedLive('b');
    seedLive('c');
    const evaluator = vi.fn(() => ({
      ok: true as const,
      action: 'wait' as const,
      reason: 'below-window' as const,
      ctx_pct: 40,
      shadow: false,
      jsonl_path: null,
      anchor_id: 'x',
    }));
    const r = await runSmartCompactTick({
      db,
      injector: vi.fn(() => ({ ok: true })),
      evaluator,
    });
    expect(r.evaluated).toBe(3);
    expect(evaluator).toHaveBeenCalledTimes(3);
    expect(r.waited.sort()).toEqual(['a', 'b', 'c']);
  });

  it("defers action='fire' to Lex (no inject, no audit row) - v2 Lex-authored summary", async () => {
    seedLive('a');
    const evaluator = vi.fn(() => ({
      ok: true as const,
      action: 'fire' as const,
      reason: 'window-open' as const,
      ctx_pct: 60,
      shadow: false,
      jsonl_path: null,
      anchor_id: 'a',
    }));
    const injector = vi.fn(() => ({ ok: true }));
    const r = await runSmartCompactTick({ db, injector, evaluator });
    /* Scheduler no longer authors the resume prompt. action='fire' is
     * deferred to Lex; the scheduler logs and skips so the worker
     * never receives a /clear followed by a blank inject. */
    expect(r.fired).toEqual([]);
    expect(r.deferredFire).toEqual(['a']);
    expect(injector).not.toHaveBeenCalled();
    expect(recentSmartCompacts(db).length).toBe(0);
  });

  it('routes action=wrap into the wrap path (no /clear)', async () => {
    seedLive('a');
    const evaluator = vi.fn(() => ({
      ok: true as const,
      action: 'wrap' as const,
      reason: 'forced-no-stop' as const,
      ctx_pct: 75,
      shadow: false,
      jsonl_path: null,
      anchor_id: 'a',
    }));
    const injector = vi.fn(() => ({ ok: true }));
    const r = await runSmartCompactTick({ db, injector, evaluator });
    expect(r.wrapped).toEqual(['a']);
    expect(injector).toHaveBeenCalledTimes(1);
    const [, text] = injector.mock.calls[0]!;
    expect(text).toMatch(/Wrap your current work/);
  });

  it("hard-ceiling reason -> still deferred to Lex (v2 - daemon doesn't author)", async () => {
    seedLive('a');
    const evaluator = vi.fn(() => ({
      ok: true as const,
      action: 'fire' as const,
      reason: 'hard-ceiling' as const,
      ctx_pct: 92,
      shadow: false,
      jsonl_path: null,
      anchor_id: 'a',
    }));
    const injector = vi.fn(() => ({ ok: true }));
    const r = await runSmartCompactTick({ db, injector, evaluator });
    /* Even at hard ceiling the daemon does not invent a summary. Lex
     * must observe the same verdict on its next poll and post the
     * resume prompt. */
    expect(r.deferredFire).toEqual(['a']);
    expect(injector).not.toHaveBeenCalled();
    expect(recentSmartCompacts(db).length).toBe(0);
  });

  it('continues past an evaluator throw on one anchor', async () => {
    seedLive('a');
    seedLive('b');
    const evaluator = vi.fn((_, id) => {
      if (id === 'a') throw new Error('boom');
      return {
        ok: true as const,
        action: 'wait' as const,
        reason: 'below-window' as const,
        ctx_pct: 30,
        shadow: false,
        jsonl_path: null,
        anchor_id: id,
      };
    });
    const r = await runSmartCompactTick({
      db,
      injector: vi.fn(() => ({ ok: true })),
      evaluator,
    });
    expect(r.errors).toEqual(['a']);
    expect(r.waited).toEqual(['b']);
  });
});
