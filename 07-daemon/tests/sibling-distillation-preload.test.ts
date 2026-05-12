/**
 * Sibling distillation preloader.
 *
 * Phase 1 of the sibling-distillation rollout. Covers:
 *   - preload-with-distillation: generator returns a string, the row
 *     gets last_summary stamped and shows up in preloaded[].
 *   - preload-fallback-no-distillation: generator returns null (or
 *     throws), row is recorded in skipped[] and last_summary stays
 *     null so buildSiblingIndex's distillation tail simply omits.
 *   - only-2-most-recent-preloaded: with 4 siblings missing
 *     summaries, the top 2 by started_ms get the generator call;
 *     the rest land in skipped[] without an LLM hit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { preloadSiblingDistillations } from '../src/lex/sibling-distillation-preload.js';
import { buildSiblingIndex } from '../src/lex/sibling-index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

function insertBs(opts: {
  id: string;
  label: string;
  started_ms: number;
  last_summary?: string | null;
}): void {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/p/lex',
    user_label: opts.label,
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: opts.started_ms,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: opts.last_summary ?? null,
    last_summary_ms: opts.last_summary ? 1 : null,
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-preload-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'Projects');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('preloadSiblingDistillations', () => {
  it('preload-with-distillation: stamps last_summary and surfaces in the sibling index', async () => {
    insertBs({ id: 'sib-1', label: 'DevNeural Testing', started_ms: 1_000 });
    const generator = vi.fn().mockResolvedValue('shipped event-driven supervision daemon side');
    const r = await preloadSiblingDistillations({
      db,
      label: 'DevNeural Testing',
      excludeId: 'new-session-id',
      generator,
      limit: 2,
      now: () => 5_000,
    });
    expect(r.preloaded).toEqual(['sib-1']);
    expect(r.skipped).toEqual([]);
    expect(generator).toHaveBeenCalledTimes(1);
    const reread = db.listBrainstorms({ limit: 50 }).find((b) => b.id === 'sib-1');
    expect(reread?.last_summary).toMatch(/shipped event-driven supervision/);
    expect(reread?.last_summary_ms).toBe(5_000);
    const block = buildSiblingIndex({
      db,
      label: 'DevNeural Testing',
      excludeId: 'new-session-id',
    });
    expect(block).toMatch(/ — shipped event-driven supervision daemon side/);
  });

  it('preload-fallback-no-distillation: null generator output leaves last_summary null', async () => {
    insertBs({ id: 'sib-1', label: 'Fallback Topic', started_ms: 1_000 });
    const generator = vi.fn().mockResolvedValue(null);
    const r = await preloadSiblingDistillations({
      db,
      label: 'Fallback Topic',
      generator,
      limit: 2,
    });
    expect(r.preloaded).toEqual([]);
    expect(r.skipped).toEqual(['sib-1']);
    const row = db.listBrainstorms({ limit: 50 }).find((b) => b.id === 'sib-1');
    expect(row?.last_summary).toBeNull();
  });

  it('preload-fallback-no-distillation: generator throws is treated as null', async () => {
    insertBs({ id: 'sib-1', label: 'Throwy Topic', started_ms: 1_000 });
    const generator = vi.fn().mockRejectedValue(new Error('llm down'));
    const r = await preloadSiblingDistillations({
      db,
      label: 'Throwy Topic',
      generator,
      limit: 2,
    });
    expect(r.preloaded).toEqual([]);
    expect(r.skipped).toEqual(['sib-1']);
  });

  it('only-2-most-recent-preloaded: with 4 candidates only the top 2 by started_ms get the generator call', async () => {
    /* started_ms ASC ordering on insert; sorted DESC at fetch by
     * listBrainstorms so newer = larger started_ms = first. */
    insertBs({ id: 'old-1', label: 'Mass Topic', started_ms: 1_000 });
    insertBs({ id: 'old-2', label: 'Mass Topic', started_ms: 2_000 });
    insertBs({ id: 'new-1', label: 'Mass Topic', started_ms: 3_000 });
    insertBs({ id: 'new-2', label: 'Mass Topic', started_ms: 4_000 });
    const generator = vi.fn().mockResolvedValue('summary text');
    const r = await preloadSiblingDistillations({
      db,
      label: 'Mass Topic',
      generator,
      limit: 2,
    });
    expect(r.preloaded.sort()).toEqual(['new-1', 'new-2']);
    expect(r.skipped.sort()).toEqual(['old-1', 'old-2']);
    expect(generator).toHaveBeenCalledTimes(2);
    const calledIds = generator.mock.calls
      .map((c) => (c[0] as { id: string }).id)
      .sort();
    expect(calledIds).toEqual(['new-1', 'new-2']);
  });

  it('skips rows that already have a last_summary, no generator call', async () => {
    insertBs({
      id: 'has-summary',
      label: 'Mixed',
      started_ms: 5_000,
      last_summary: 'already done',
    });
    insertBs({ id: 'no-summary', label: 'Mixed', started_ms: 4_000 });
    const generator = vi.fn().mockResolvedValue('new summary');
    const r = await preloadSiblingDistillations({
      db,
      label: 'Mixed',
      generator,
      limit: 2,
    });
    expect(r.already_present).toEqual(['has-summary']);
    expect(r.preloaded).toEqual(['no-summary']);
    expect(generator).toHaveBeenCalledTimes(1);
  });

  it('returns empty when label is null / empty without calling the generator', async () => {
    insertBs({ id: 'sib-1', label: '', started_ms: 1_000 });
    const generator = vi.fn();
    const r = await preloadSiblingDistillations({
      db,
      label: null,
      generator,
    });
    expect(r).toEqual({
      preloaded: [],
      skipped: [],
      already_present: [],
    });
    expect(generator).not.toHaveBeenCalled();
  });
});
