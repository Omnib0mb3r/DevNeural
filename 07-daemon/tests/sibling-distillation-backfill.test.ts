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
  /** Insert one canned chunk so the pre-filter sees content. Defaults
   * to true; pass false to exercise the chunkless-skip path. */
  withChunk?: boolean;
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
  if (opts.withChunk !== false) {
    db.insertBrainstormChunk({
      id: `c-${opts.id}`,
      brainstorm_id: opts.id,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'thinking out loud about the design',
      model_id: 'stub',
      no_decay: 1,
    });
  }
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
    /* Row HAS chunks so the pre-filter passes and the generator is
     * actually invoked. The null return from the generator is the
     * "real failure" branch and must bucket as error. */
    insertBs({ id: 'a', label: 'T', started_ms: 1 });
    const generator = vi.fn().mockResolvedValue(null);
    const r = await runDistillationBackfill({ db, generator, limit: 5 });
    expect(generator).toHaveBeenCalledTimes(1);
    expect(r.processed).toEqual([]);
    expect(r.errors).toEqual(['a']);
    expect(r.skipped).toEqual([]);
    const reread = db.listBrainstorms({ limit: 5 }).find((b) => b.id === 'a');
    expect(reread?.last_summary).toBeNull();
  });

  it('generator throws land in errors[] (transcript existed, run failed)', async () => {
    insertBs({ id: 'boom', label: 'T', started_ms: 1 });
    const generator = vi.fn().mockRejectedValue(new Error('llm down'));
    const r = await runDistillationBackfill({ db, generator, limit: 5 });
    expect(generator).toHaveBeenCalledTimes(1);
    expect(r.errors).toEqual(['boom']);
    expect(r.skipped).toEqual([]);
    expect(r.processed).toEqual([]);
  });

  it('chunkless brainstorms land in skipped[], not errors, and the generator is never called', async () => {
    /* Two chunkless rows + one chunked row. Only the chunked row
     * should reach the generator; the chunkless ones bucket as
     * skipped because there is no transcript to distill. The
     * scheduler's log surface should also see a one-line summary
     * of the chunkless skip so daemon.log stops printing one
     * "[distill-gen] no chunks" per row per tick. */
    insertBs({ id: 'empty-1', label: 'T', started_ms: 1, withChunk: false });
    insertBs({ id: 'empty-2', label: 'T', started_ms: 2, withChunk: false });
    insertBs({ id: 'full', label: 'T', started_ms: 3 });
    const generator = vi.fn().mockResolvedValue('one line summary');
    const logs: string[] = [];
    const r = await runDistillationBackfill({
      db,
      generator,
      limit: 5,
      log: (m) => logs.push(m),
    });
    expect(generator).toHaveBeenCalledTimes(1);
    expect(generator.mock.calls[0]![0]!.id).toBe('full');
    expect(r.processed).toEqual(['full']);
    expect(r.errors).toEqual([]);
    expect(r.skipped.sort()).toEqual(['empty-1', 'empty-2']);
    expect(r.hit_cap).toBe(false);
    expect(
      logs.find((l) =>
        /skipped 2 brainstorms with no chunks and no jsonl refs/.test(l),
      ),
    ).toBeTruthy();
  });

  it('chunkless rows do not consume the per-run cap', async () => {
    /* 3 chunkless + 5 chunked + cap=5. Cap should bite on the
     * chunked rows only; chunkless rows fill the skipped bucket
     * alongside any chunked rows the cap pushed past. */
    for (let i = 0; i < 3; i++) {
      insertBs({
        id: `empty-${i}`,
        label: 'T',
        started_ms: i + 1,
        withChunk: false,
      });
    }
    for (let i = 0; i < 5; i++) {
      insertBs({
        id: `full-${i}`,
        label: 'T',
        started_ms: 100 + i,
      });
    }
    const generator = vi.fn().mockResolvedValue('summary');
    const r = await runDistillationBackfill({ db, generator, limit: 5 });
    expect(generator).toHaveBeenCalledTimes(5);
    expect(r.processed.length).toBe(5);
    expect(r.errors).toEqual([]);
    /* All 3 chunkless land in skipped; cap did NOT bite on chunked
     * rows so hit_cap stays false. */
    expect(r.skipped.length).toBe(3);
    expect(r.hit_cap).toBe(false);
  });

  /* Insert a lex_transcript_ref under a brainstorm and set its
   * freshness columns directly. ref_summary_ms / latest_chunk_ms drive
   * isRefStale (latest_chunk_ms > ref_summary_ms -> stale). */
  function insertRef(opts: {
    lexSessionId: string;
    cc: string;
    ordering: number;
    refSummaryMs: number | null;
    latestChunkMs: number | null;
  }): number {
    /* lex_transcript_ref.lex_session_id FKs lex_session(id); migration
     * 018 gives each brainstorm a same-id lex_session row. Mirror that
     * so the ref insert satisfies the constraint. Idempotent per id. */
    try {
      db.insertLexSession({
        id: opts.lexSessionId,
        created_ms: 1_000,
        title: null,
        derived_title: null,
        status: 'dormant',
        current_pty_id: null,
        cwd: 'C:/p/lex',
      });
    } catch {
      /* already inserted for a prior ref on the same anchor */
    }
    const ref = db.insertLexTranscriptRef({
      lex_session_id: opts.lexSessionId,
      cc_session_id: opts.cc,
      transcript_path: `C:/x/${opts.cc}.jsonl`,
      started_ms: 1_000 + opts.ordering,
      ended_ms: null,
      ordering: opts.ordering,
    });
    db.updateLexTranscriptRef(ref.id, {
      ref_summary_ms: opts.refSummaryMs,
      latest_chunk_ms: opts.latestChunkMs,
    });
    return ref.id;
  }

  it('re-distills a summarized row when a child ref is stale and flips ref_summary_ms fresh', async () => {
    /* The exact production bug: the row HAS a last_summary (so the old
     * looksLikeSelfAudit guard excluded it) but a chunk landed after
     * the last per-ref distill, so the ref is stale. It must now be a
     * candidate, and a successful re-distill must stamp the ref's
     * ref_summary_ms so isRefStale flips false. */
    insertBs({
      id: 'anchor',
      label: 'T',
      started_ms: 1_000,
      last_summary: 'stale summary',
    });
    insertRef({
      lexSessionId: 'anchor',
      cc: 'cc-1',
      ordering: 0,
      refSummaryMs: 100,
      latestChunkMs: 500,
    });
    const generator = vi.fn().mockResolvedValue('fresh re-distillation');
    const r = await runDistillationBackfill({
      db,
      generator,
      limit: 5,
      now: () => 9_999,
    });
    expect(r.processed).toEqual(['anchor']);
    expect(generator).toHaveBeenCalledTimes(1);

    const { isRefStale } = await import('../src/lex/lex-transcript-ref.js');
    const reread = db.getLexTranscriptRefByCc('cc-1')!;
    expect(reread.ref_summary_ms).toBe(9_999);
    expect(reread.latest_chunk_ms).toBe(500);
    expect(isRefStale(reread)).toBe(false);

    const bs = db.getBrainstorm('anchor')!;
    expect(bs.last_summary).toBe('fresh re-distillation');
    expect(bs.last_summary_ms).toBe(9_999);
  });

  it('leaves a summarized row alone when all of its child refs are fresh', async () => {
    insertBs({
      id: 'fresh-anchor',
      label: 'T',
      started_ms: 1_000,
      last_summary: 'current',
    });
    insertRef({
      lexSessionId: 'fresh-anchor',
      cc: 'cc-f',
      ordering: 0,
      refSummaryMs: 500,
      latestChunkMs: 100,
    });
    const generator = vi.fn().mockResolvedValue('should not run');
    const r = await runDistillationBackfill({ db, generator, limit: 5 });
    expect(generator).not.toHaveBeenCalled();
    expect(r.processed).toEqual([]);
  });

  it('flips every stale ref on the row in a single re-distill and leaves fresh refs untouched', async () => {
    insertBs({
      id: 'multi',
      label: 'T',
      started_ms: 1_000,
      last_summary: 'old',
    });
    insertRef({
      lexSessionId: 'multi',
      cc: 'cc-a',
      ordering: 0,
      refSummaryMs: 100,
      latestChunkMs: 500,
    }); // stale
    insertRef({
      lexSessionId: 'multi',
      cc: 'cc-b',
      ordering: 1,
      refSummaryMs: 200,
      latestChunkMs: 900,
    }); // stale
    insertRef({
      lexSessionId: 'multi',
      cc: 'cc-c',
      ordering: 2,
      refSummaryMs: 800,
      latestChunkMs: 100,
    }); // fresh
    const generator = vi.fn().mockResolvedValue('redistill');
    const r = await runDistillationBackfill({
      db,
      generator,
      limit: 5,
      now: () => 7_000,
    });
    expect(generator).toHaveBeenCalledTimes(1);
    expect(r.processed).toEqual(['multi']);

    const { isRefStale } = await import('../src/lex/lex-transcript-ref.js');
    for (const cc of ['cc-a', 'cc-b', 'cc-c']) {
      expect(isRefStale(db.getLexTranscriptRefByCc(cc)!)).toBe(false);
    }
    expect(db.getLexTranscriptRefByCc('cc-a')!.ref_summary_ms).toBe(7_000);
    expect(db.getLexTranscriptRefByCc('cc-b')!.ref_summary_ms).toBe(7_000);
    /* Fresh ref's stamp must be left exactly as it was. */
    expect(db.getLexTranscriptRefByCc('cc-c')!.ref_summary_ms).toBe(800);
  });
});
