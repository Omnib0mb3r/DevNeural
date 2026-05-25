/**
 * Stage 2 of LEX-AUTONOMY-PAYLOAD-SPEC.md - six blocking contract
 * tests adopted from the Codex peer review. Each one pins one
 * behavior the new per-session distillation pipeline MUST honor.
 *
 *   1. attached-worker session-end -> non-empty ref_summary
 *   2. no-worker session-end       -> non-empty ref_summary
 *   3. two concurrent CC sessions  -> two isolated ref_summary rows,
 *                                     no chunk leak between them
 *   4. retry recompute             -> idempotent overwrite
 *   5. N=0 aggregate               -> handles empty cleanly
 *   6. historical NULL chunks      -> no crash, structured skip
 *
 * Stubs createPerSessionDistillationGenerator so the test never
 * hits ollama; the stub returns deterministic content the
 * assertions can reason about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

/* Stub generator. The stub embeds (a) the brainstorm id and (b) a
 * counter so assertions can confirm a retry actually re-ran the
 * generator vs serving a cached value (the writer should overwrite
 * deterministically regardless). */
let stubCounter = 0;
vi.mock('../src/lex/distillation-generator.js', async () => {
  return {
    createLlmDistillationGenerator: () => async (row: { id: string }) => {
      return `legacy anchor-flat for ${row.id}`;
    },
    createPerSessionDistillationGenerator: () => async (input: {
      brainstorm_id: string;
      cc_session_id: string;
      totalChunksInSession: number;
    }) => {
      stubCounter += 1;
      return {
        summary: `STUB[${stubCounter}] bs=${input.brainstorm_id} cc=${input.cc_session_id} n=${input.totalChunksInSession}`,
        source_chunk_count: input.totalChunksInSession,
        source_session_ids: JSON.stringify([input.cc_session_id]),
        coverage_score: 1,
      };
    },
    SYSTEM_BLOCK: { text: 'stub', cache: false },
    PER_SESSION_SYSTEM_BLOCK: { text: 'stub', cache: false },
  };
});

let tmpDir: string;
let priors: {
  DEVNEURAL_DATA_ROOT?: string;
  DEVNEURAL_LLM_PROVIDER?: string;
  DEVNEURAL_PROJECTS_ROOT?: string;
  HOME?: string;
  USERPROFILE?: string;
};

beforeEach(() => {
  stubCounter = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-stage2-'));
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'EmptyProjectsRoot'), { recursive: true });
  priors = {
    DEVNEURAL_DATA_ROOT: process.env.DEVNEURAL_DATA_ROOT,
    DEVNEURAL_LLM_PROVIDER: process.env.DEVNEURAL_LLM_PROVIDER,
    DEVNEURAL_PROJECTS_ROOT: process.env.DEVNEURAL_PROJECTS_ROOT,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_LLM_PROVIDER = 'none';
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'EmptyProjectsRoot');
  process.env.HOME = path.join(tmpDir, 'home');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
});

afterEach(() => {
  for (const [k, v] of Object.entries(priors)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows holds sqlite briefly; OS reclaims. */
  }
});

interface SeedOpts {
  brainstormId: string;
  ccSessionId: string;
  projectId: string;
  workerSessionId?: string;
  chunkTexts?: string[];
  /* When set, write chunks with NULL cc_session_id (historical
   * pre-Stage 0 case). Defaults to false. */
  nullCcOnChunks?: boolean;
}

async function seedAttachedSession(
  dbFile: string,
  opts: SeedOpts,
): Promise<void> {
  const { IndexDb } = await import('../src/store/index-db.js');
  const { runMigrations } = await import('../src/db/migrate.js');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  const db = new IndexDb(dbFile);
  /* Unique raw_chunks id per (brainstorm, cc) pair so two concurrent
   * seeds against the same anchor don't have the second
   * upsertRawChunk silently overwrite the first row's session_id.
   * Without this, projectIdBySession(first cc) returns null after
   * the second seed and runOrderedPipeline falls back to the
   * brainstorm_chunks path instead of taking the per-session
   * branch this test pins. */
  db.upsertRawChunk({
    id: `raw-${opts.brainstormId}-${opts.ccSessionId}`,
    project_id: opts.projectId,
    session_id: opts.ccSessionId,
    timestamp_ms: Date.now() - 30_000,
    kind: 'text',
    role: 'user',
    byte_length: 16,
  });
  const existing = db.getBrainstorm(opts.brainstormId);
  if (!existing) {
    db.insertBrainstorm({
      id: opts.brainstormId,
      claude_session_id: opts.ccSessionId,
      pty_id: null,
      cwd: `/synthetic/${opts.brainstormId}`,
      user_label: 'Stage2 Contract',
      derived_label: null,
      mode: 'conversation',
      status: 'active',
      started_ms: Date.now() - 60_000,
      ended_ms: null,
      turn_count: opts.chunkTexts?.length ?? 2,
      topic_tags_json: '[]',
      artifacts_json: '{}',
      last_summary: null,
      last_summary_ms: null,
    });
  }
  if (opts.workerSessionId) {
    db.updateBrainstorm(opts.brainstormId, {
      attached_worker_session_id: opts.workerSessionId,
      lifecycle_state: 'attached',
      runtime_mode: 'cc-pty',
    });
  }
  const lexExisting = db.getLexSession(opts.brainstormId);
  if (!lexExisting) {
    db.insertLexSession({
      id: opts.brainstormId,
      created_ms: Date.now() - 60_000,
      title: opts.brainstormId,
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: `/synthetic/${opts.brainstormId}`,
    });
  }
  const refExisting = db.getLexTranscriptRefByCc(opts.ccSessionId);
  if (!refExisting) {
    db.insertLexTranscriptRef({
      lex_session_id: opts.brainstormId,
      cc_session_id: opts.ccSessionId,
      transcript_path: `/synthetic/${opts.brainstormId}/${opts.ccSessionId}.jsonl`,
      started_ms: Date.now() - 60_000,
      ended_ms: null,
      ordering: 0,
    });
  }
  const texts = opts.chunkTexts ?? ['user turn one', 'lex turn one'];
  texts.forEach((t, i) => {
    db.insertBrainstormChunk({
      id: `chunk-${opts.ccSessionId}-${i}`,
      brainstorm_id: opts.brainstormId,
      turn_index: i + db.nextTurnIndex(opts.brainstormId),
      role: i % 2 === 0 ? 'user' : 'lex',
      mode: 'conversation',
      text: t,
      model_id: i % 2 === 0 ? '' : 'claude',
      no_decay: 1,
      cc_session_id: opts.nullCcOnChunks ? null : opts.ccSessionId,
    });
  });
  db.close();
}

describe('Stage 2 contract: attached-worker session-end produces non-empty ref_summary', () => {
  it('writes ref_summary + last_summary aggregate when worker is bound', async () => {
    const dbFile = path.join(tmpDir, 'index.db');
    await seedAttachedSession(dbFile, {
      brainstormId: 'bs-1',
      ccSessionId: 'cc-1',
      projectId: 'p-1',
      workerSessionId: 'worker-cc-1',
    });
    const { Store } = await import('../src/store/index.js');
    const store = await Store.open();
    const { runSessionEndPipeline } = await import(
      '../src/lex/session-end-pipeline.js'
    );
    await runSessionEndPipeline(store, {
      brainstormId: 'bs-1',
      claudeSessionId: 'cc-1',
      mode: 'conversation',
      reason: 'pty-exit',
    });
    const { IndexDb } = await import('../src/store/index-db.js');
    const verify = new IndexDb(dbFile);
    const ref = verify.getLexTranscriptRefByCc('cc-1');
    const row = verify.getBrainstorm('bs-1');
    verify.close();
    expect(ref?.ref_summary).toBeTruthy();
    expect(ref?.ref_summary).toContain('bs=bs-1 cc=cc-1');
    expect(ref?.coverage_score).toBe(1);
    expect(row?.last_summary).toContain('bs=bs-1 cc=cc-1');
    expect(row?.last_summary_ms ?? 0).toBeGreaterThan(0);
    expect(row?.attached_worker_session_id).toBe('worker-cc-1');
  });
});

describe('Stage 2 contract: no-worker session-end still produces ref_summary', () => {
  it('writes ref_summary on session-end even when no worker is attached', async () => {
    const dbFile = path.join(tmpDir, 'index.db');
    await seedAttachedSession(dbFile, {
      brainstormId: 'bs-solo',
      ccSessionId: 'cc-solo',
      projectId: 'p-solo',
      /* workerSessionId intentionally omitted: standalone Lex
       * session with no worker. */
    });
    const { Store } = await import('../src/store/index.js');
    const store = await Store.open();
    const { runSessionEndPipeline } = await import(
      '../src/lex/session-end-pipeline.js'
    );
    await runSessionEndPipeline(store, {
      brainstormId: 'bs-solo',
      claudeSessionId: 'cc-solo',
      mode: 'conversation',
      reason: 'pty-exit',
    });
    const { IndexDb } = await import('../src/store/index-db.js');
    const verify = new IndexDb(dbFile);
    const ref = verify.getLexTranscriptRefByCc('cc-solo');
    const row = verify.getBrainstorm('bs-solo');
    verify.close();
    expect(ref?.ref_summary).toBeTruthy();
    expect(ref?.ref_summary).toContain('bs=bs-solo');
    expect(row?.attached_worker_session_id ?? null).toBeNull();
    expect(row?.last_summary).toContain('bs=bs-solo');
  });
});

describe('Stage 2 contract: two concurrent CC sessions isolate ref_summary rows', () => {
  it('produces two independent ref_summary rows with no chunk leak', async () => {
    const dbFile = path.join(tmpDir, 'index.db');
    /* Two CC sessions on the SAME anchor (brainstorm_id). Each
     * ref row's distillation must see only its own chunks, not
     * the other's. The Stage 0 cc_session_id stamping on each
     * chunk is what makes this isolation possible at the read
     * layer. */
    await seedAttachedSession(dbFile, {
      brainstormId: 'bs-multi',
      ccSessionId: 'cc-A',
      projectId: 'p-multi',
      chunkTexts: ['A-user-1', 'A-lex-1', 'A-user-2', 'A-lex-2'],
    });
    await seedAttachedSession(dbFile, {
      brainstormId: 'bs-multi',
      ccSessionId: 'cc-B',
      projectId: 'p-multi',
      chunkTexts: ['B-user-1', 'B-lex-1'],
    });
    const { Store } = await import('../src/store/index.js');
    const store = await Store.open();
    const { runSessionEndPipeline } = await import(
      '../src/lex/session-end-pipeline.js'
    );
    await runSessionEndPipeline(store, {
      brainstormId: 'bs-multi',
      claudeSessionId: 'cc-A',
      mode: 'conversation',
      reason: 'pty-exit',
    });
    await runSessionEndPipeline(store, {
      brainstormId: 'bs-multi',
      claudeSessionId: 'cc-B',
      mode: 'conversation',
      reason: 'pty-exit',
    });
    const { IndexDb } = await import('../src/store/index-db.js');
    const verify = new IndexDb(dbFile);
    const refA = verify.getLexTranscriptRefByCc('cc-A');
    const refB = verify.getLexTranscriptRefByCc('cc-B');
    /* Source chunk counts reflect each session's own chunk count,
     * NOT the anchor-wide total. cc-A had 4 chunks, cc-B had 2. */
    expect(refA?.source_chunk_count).toBe(4);
    expect(refB?.source_chunk_count).toBe(2);
    /* source_session_ids carries each ref's own cc_session_id and
     * NOT the other. */
    expect(JSON.parse(refA?.source_session_ids ?? '[]')).toEqual(['cc-A']);
    expect(JSON.parse(refB?.source_session_ids ?? '[]')).toEqual(['cc-B']);
    /* Rolling aggregate should now contain BOTH session
     * summaries, newest-first. */
    const row = verify.getBrainstorm('bs-multi');
    verify.close();
    expect(row?.last_summary).toContain('cc=cc-A');
    expect(row?.last_summary).toContain('cc=cc-B');
  });
});

describe('Stage 2 contract: retry recompute is idempotent overwrite', () => {
  it('re-running the pipeline overwrites the ref row deterministically (last-writer-wins)', async () => {
    const dbFile = path.join(tmpDir, 'index.db');
    await seedAttachedSession(dbFile, {
      brainstormId: 'bs-retry',
      ccSessionId: 'cc-retry',
      projectId: 'p-retry',
    });
    const { Store } = await import('../src/store/index.js');
    const store = await Store.open();
    const { runSessionEndPipeline } = await import(
      '../src/lex/session-end-pipeline.js'
    );
    await runSessionEndPipeline(store, {
      brainstormId: 'bs-retry',
      claudeSessionId: 'cc-retry',
      mode: 'conversation',
      reason: 'pty-exit',
    });
    const { IndexDb } = await import('../src/store/index-db.js');
    const firstVerify = new IndexDb(dbFile);
    const refFirst = firstVerify.getLexTranscriptRefByCc('cc-retry');
    firstVerify.close();
    const firstSummary = refFirst?.ref_summary ?? '';
    const firstMs = refFirst?.ref_summary_ms ?? 0;
    expect(firstSummary).toContain('STUB[');
    /* Run again to simulate a retry / re-flush. The stub counter
     * advances so the new summary text differs from the first; the
     * writer must overwrite the same ref row id (single row per
     * cc_session_id by the unique index) and bump ref_summary_ms. */
    await new Promise((r) => setTimeout(r, 5));
    await runSessionEndPipeline(store, {
      brainstormId: 'bs-retry',
      claudeSessionId: 'cc-retry',
      mode: 'conversation',
      reason: 'admin-redistill',
    });
    const secondVerify = new IndexDb(dbFile);
    const refSecond = secondVerify.getLexTranscriptRefByCc('cc-retry');
    /* Confirm there is still exactly ONE ref row for this cc;
     * idempotent overwrite must not insert a duplicate. */
    const allRefs = secondVerify.listLexTranscriptRefs('bs-retry');
    secondVerify.close();
    expect(allRefs.length).toBe(1);
    expect(refSecond?.id).toBe(refFirst?.id);
    expect(refSecond?.ref_summary).not.toBe(firstSummary);
    expect(refSecond?.ref_summary).toContain('STUB[');
    expect(refSecond?.ref_summary_ms ?? 0).toBeGreaterThanOrEqual(firstMs);
  });
});

describe('Stage 2 contract: N=0 aggregate handles empty cleanly', () => {
  it('recomputeRollingAggregate returns null when no ref_summary rows exist', async () => {
    const dbFile = path.join(tmpDir, 'index.db');
    const { IndexDb } = await import('../src/store/index-db.js');
    const { runMigrations } = await import('../src/db/migrate.js');
    const idx = new IndexDb(dbFile);
    idx.close();
    await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
    const db = new IndexDb(dbFile);
    db.insertLexSession({
      id: 'bs-empty',
      created_ms: Date.now(),
      title: 'empty',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: '/empty',
    });
    /* Insert a ref row but DO NOT populate ref_summary; the
     * aggregate should treat this as "no ref_summaries available"
     * and return null rather than synthesising from an empty set. */
    db.insertLexTranscriptRef({
      lex_session_id: 'bs-empty',
      cc_session_id: 'cc-empty',
      transcript_path: '/empty/cc-empty.jsonl',
      started_ms: Date.now(),
      ended_ms: null,
      ordering: 0,
    });
    const { recomputeRollingAggregate, renderAggregate } = await import(
      '../src/lex/rolling-aggregate.js'
    );
    const agg = recomputeRollingAggregate(db, 'bs-empty');
    expect(agg).toBeNull();
    /* renderAggregate on empty input is also null (defensive
     * against future callers passing arbitrary arrays). */
    expect(renderAggregate([], 8000)).toBeNull();
    /* Empty refs (rows where ref_summary IS NULL) are filtered
     * out by listRecentRefSummariesForLexSession, so even with the
     * ref row present the helper returns null. */
    db.close();
  });
});

describe('Stage 2 contract: historical NULL cc_session_id chunks do not crash the pipeline', () => {
  it('logs no_session_scoped_chunks and leaves ref_summary NULL when chunks have NULL cc_session_id', async () => {
    const dbFile = path.join(tmpDir, 'index.db');
    await seedAttachedSession(dbFile, {
      brainstormId: 'bs-null',
      ccSessionId: 'cc-null',
      projectId: 'p-null',
      /* Pre-Stage-0 chunks: cc_session_id never stamped. */
      nullCcOnChunks: true,
    });
    const logs: string[] = [];
    const { Store } = await import('../src/store/index.js');
    const store = await Store.open();
    const { runSessionEndPipeline } = await import(
      '../src/lex/session-end-pipeline.js'
    );
    /* Wrap in try so any unexpected throw fails the test loudly;
     * the contract is "no crash", not "best-effort swallow". */
    await expect(
      runSessionEndPipeline(
        store,
        {
          brainstormId: 'bs-null',
          claudeSessionId: 'cc-null',
          mode: 'conversation',
          reason: 'pty-exit',
        },
        (msg) => logs.push(msg),
      ),
    ).resolves.toBeDefined();
    const { IndexDb } = await import('../src/store/index-db.js');
    const verify = new IndexDb(dbFile);
    const ref = verify.getLexTranscriptRefByCc('cc-null');
    const row = verify.getBrainstorm('bs-null');
    verify.close();
    /* Structured skip reason landed in the log. */
    expect(
      logs.some((l) => l.includes('no_session_scoped_chunks')),
    ).toBe(true);
    /* ref row exists from the seed but ref_summary stayed NULL. */
    expect(ref).not.toBeNull();
    expect(ref?.ref_summary).toBeNull();
    /* last_summary also untouched (Stage 2 contract: no anchor-flat
     * fallback when scoped chunks are missing). */
    expect(row?.last_summary).toBeNull();
  });
});
