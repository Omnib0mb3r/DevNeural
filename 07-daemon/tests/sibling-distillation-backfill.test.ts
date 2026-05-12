/**
 * Sibling distillation backfill job (phase 2).
 *
 * Cap at N=5 rows per run so a cold start cannot melt the LLM
 * provider. Covers:
 *   - backfill-job-respects-cap: 12 candidates with no summary, only
 *     5 reach the generator, the rest land in skipped[] and hit_cap
 *     is true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { runDistillationBackfill } from '../src/lex/sibling-distillation-backfill.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

function insertBs(opts: {
  id: string;
  label: string | null;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-backfill-'));
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

describe('runDistillationBackfill', () => {
  it('backfill-job-respects-cap: 12 missing-summary rows, only 5 are processed in one run', async () => {
    for (let i = 0; i < 12; i++) {
      insertBs({
        id: `row-${i.toString().padStart(2, '0')}`,
        label: 'Mass Backfill',
        started_ms: 1_000 + i,
      });
    }
    const generator = vi.fn().mockResolvedValue('one line summary text');
    const r = await runDistillationBackfill({
      db,
      generator,
      limit: 5,
      now: () => 9_999,
    });
    expect(r.processed.length).toBe(5);
    expect(r.skipped.length).toBe(7);
    expect(r.errors).toEqual([]);
    expect(r.hit_cap).toBe(true);
    expect(generator).toHaveBeenCalledTimes(5);
    /* Only the 5 processed ids should have a last_summary set;
     * the other 7 stay null and will be picked up next run. */
    const rows = db.listBrainstorms({ limit: 50 });
    const withSummary = rows.filter((r) => r.last_summary !== null);
    expect(withSummary.length).toBe(5);
  });

  it('does not re-distill rows that already have a last_summary', async () => {
    insertBs({
      id: 'has-summary',
      label: 'Topic',
      started_ms: 1_000,
      last_summary: 'pre-existing',
    });
    insertBs({ id: 'no-summary', label: 'Topic', started_ms: 2_000 });
    const generator = vi.fn().mockResolvedValue('fresh summary');
    const r = await runDistillationBackfill({ db, generator, limit: 5 });
    expect(r.processed).toEqual(['no-summary']);
    expect(generator).toHaveBeenCalledTimes(1);
  });

  it('processes most-recent first when more than the cap is available', async () => {
    insertBs({ id: 'old', label: 'T', started_ms: 1_000 });
    insertBs({ id: 'mid', label: 'T', started_ms: 2_000 });
    insertBs({ id: 'new', label: 'T', started_ms: 3_000 });
    const generator = vi.fn().mockResolvedValue('s');
    const r = await runDistillationBackfill({ db, generator, limit: 2 });
    expect(r.processed.sort()).toEqual(['mid', 'new']);
    expect(r.skipped).toEqual(['old']);
  });

  it('label filter restricts to matching rows', async () => {
    insertBs({ id: 'a', label: 'Yes', started_ms: 1 });
    insertBs({ id: 'b', label: 'No', started_ms: 2 });
    const generator = vi.fn().mockResolvedValue('s');
    const r = await runDistillationBackfill({
      db,
      generator,
      label: 'Yes',
      limit: 10,
    });
    expect(r.processed).toEqual(['a']);
  });

  it('excludeId drops the new spawn from the backfill candidate list', async () => {
    insertBs({ id: 'spawn', label: 'T', started_ms: 5_000 });
    insertBs({ id: 'older', label: 'T', started_ms: 1_000 });
    const generator = vi.fn().mockResolvedValue('s');
    const r = await runDistillationBackfill({
      db,
      generator,
      excludeId: 'spawn',
      limit: 5,
    });
    expect(r.processed).toEqual(['older']);
    expect(generator).toHaveBeenCalledTimes(1);
  });

  it('generator failures land in errors[] without bumping the row', async () => {
    insertBs({ id: 'a', label: 'T', started_ms: 1 });
    const generator = vi.fn().mockResolvedValue(null);
    const r = await runDistillationBackfill({ db, generator, limit: 5 });
    expect(r.processed).toEqual([]);
    expect(r.errors).toEqual(['a']);
    const reread = db.listBrainstorms({ limit: 5 }).find((b) => b.id === 'a');
    expect(reread?.last_summary).toBeNull();
  });
});
