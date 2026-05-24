/**
 * Regression test for Fix 2026-05-24:
 *   cold-start preload pulls stale distillation despite recent
 *   ended sessions.
 *
 * Confirms that ending a brainstorm via the canonical session-end
 * pipeline path (claudeSessionId + projectId both resolvable +
 * attached_worker_session_id set, i.e. a worker is bound) leaves
 * brainstorm_sessions.last_summary populated. Previously the
 * canonical path wrote only the brainstorm-summary raw_chunks
 * record and left last_summary NULL; the cold-start sibling
 * preload reads last_summary and silently fell back to the most
 * recent older sibling that DID have a value, pinning the
 * preamble to a stale distillation timestamp.
 *
 * Stubs the LLM provider via vi.mock on distillation-generator so
 * the test does not hit ollama. Pipeline side steps (gpu drain,
 * force ingest, audio finalise, summary refresh) are best-effort
 * and log+continue on failure, so this test only asserts the
 * last_summary write rather than every step's success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

vi.mock('../src/lex/distillation-generator.js', async () => {
  return {
    createLlmDistillationGenerator: () => async (row: { id: string }) => {
      return `stub last_summary for ${row.id}`;
    },
    SYSTEM_BLOCK: { text: 'stub', cache: false },
  };
});

let tmpDir: string;
let priorRoot: string | undefined;
let priorProvider: string | undefined;
let priorProjectsRoot: string | undefined;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-last-summary-'));
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), { recursive: true });
  /* Use an isolated empty projects root so migration 019 has nothing to
   * backfill; that avoids UNIQUE collisions when the test inserts its
   * own synthetic project_session rows below. */
  fs.mkdirSync(path.join(tmpDir, 'EmptyProjectsRoot'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  priorProvider = process.env.DEVNEURAL_LLM_PROVIDER;
  priorProjectsRoot = process.env.DEVNEURAL_PROJECTS_ROOT;
  priorHome = process.env.HOME;
  priorUserProfile = process.env.USERPROFILE;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_LLM_PROVIDER = 'none';
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'EmptyProjectsRoot');
  process.env.HOME = path.join(tmpDir, 'home');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
});

afterEach(async () => {
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  if (priorProvider === undefined) delete process.env.DEVNEURAL_LLM_PROVIDER;
  else process.env.DEVNEURAL_LLM_PROVIDER = priorProvider;
  if (priorProjectsRoot === undefined) delete process.env.DEVNEURAL_PROJECTS_ROOT;
  else process.env.DEVNEURAL_PROJECTS_ROOT = priorProjectsRoot;
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = priorUserProfile;
  vi.resetModules();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows sometimes holds the better-sqlite3 file briefly past
     * the test; best-effort cleanup, the OS will reclaim eventually. */
  }
});

describe('session-end pipeline last_summary write (Fix 2026-05-24)', () => {
  it('writes brainstorm_sessions.last_summary when ending an attached cc-pty brainstorm', async () => {
    const dbFile = path.join(tmpDir, 'index.db');
    const { IndexDb } = await import('../src/store/index-db.js');
    const { runMigrations } = await import('../src/db/migrate.js');
    let idx = new IndexDb(dbFile);
    idx.close();
    await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
    const db = new IndexDb(dbFile);

    const bsId = 'bs-attached';
    const lexSessionId = 'lex-cc-session-uuid-attached';
    const workerSessionId = 'worker-cc-session-uuid-attached';
    const projectId = 'proj-attached';
    const cwd = '/synthetic/attached-test';

    /* Map Lex's CC session to a project via raw_chunks_meta so
     * projectIdBySession resolves and the canonical pipeline path
     * (not the brainstorm_chunks fallback) executes. */
    db.upsertRawChunk({
      id: 'raw-seed',
      project_id: projectId,
      session_id: lexSessionId,
      timestamp_ms: Date.now() - 30_000,
      kind: 'text',
      role: 'user',
      byte_length: 16,
    });

    db.insertBrainstorm({
      id: bsId,
      claude_session_id: lexSessionId,
      pty_id: null,
      cwd,
      user_label: 'DevNeural Testing',
      derived_label: null,
      mode: 'conversation',
      status: 'active',
      started_ms: Date.now() - 60_000,
      ended_ms: null,
      turn_count: 4,
      topic_tags_json: '[]',
      artifacts_json: '{}',
      last_summary: null,
      last_summary_ms: null,
    });
    db.updateBrainstorm(bsId, {
      attached_worker_session_id: workerSessionId,
      lifecycle_state: 'attached',
      runtime_mode: 'cc-pty',
    });

    db.insertBrainstormChunk({
      id: 'chunk-user-1',
      brainstorm_id: bsId,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'lets discuss the cold-start preload bug',
      model_id: '',
      no_decay: 1,
    });
    db.insertBrainstormChunk({
      id: 'chunk-lex-1',
      brainstorm_id: bsId,
      turn_index: 1,
      role: 'lex',
      mode: 'conversation',
      text: 'walk me through the symptom and the recent commits in the area',
      model_id: 'claude',
      no_decay: 1,
    });
    db.close();

    const { Store } = await import('../src/store/index.js');
    const store = await Store.open();

    const { runSessionEndPipeline } = await import(
      '../src/lex/session-end-pipeline.js'
    );

    const result = await runSessionEndPipeline(store, {
      brainstormId: bsId,
      claudeSessionId: lexSessionId,
      mode: 'conversation',
      reason: 'pty-exit',
    });

    expect(result.was_primary_runner).toBe(true);

    const verifyDb = new IndexDb(dbFile);
    const row = verifyDb.getBrainstorm(bsId);
    verifyDb.close();
    expect(row).not.toBeNull();
    expect(row?.attached_worker_session_id).toBe(workerSessionId);
    expect(row?.last_summary).toBe(`stub last_summary for ${bsId}`);
    expect(row?.last_summary_ms ?? 0).toBeGreaterThan(0);
  });

  it('redistill flush also writes last_summary on a brainstorm whose end already ran without one', async () => {
    const dbFile = path.join(tmpDir, 'index.db');
    const { IndexDb } = await import('../src/store/index-db.js');
    const { runMigrations } = await import('../src/db/migrate.js');
    let idx = new IndexDb(dbFile);
    idx.close();
    await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
    const db = new IndexDb(dbFile);

    const bsId = 'bs-retro';
    const lexSessionId = 'lex-cc-session-uuid-retro';
    const projectId = 'proj-retro';
    const cwd = '/synthetic/retro-test';

    db.upsertRawChunk({
      id: 'raw-seed-retro',
      project_id: projectId,
      session_id: lexSessionId,
      timestamp_ms: Date.now() - 7200_000,
      kind: 'text',
      role: 'user',
      byte_length: 16,
    });

    db.insertBrainstorm({
      id: bsId,
      claude_session_id: lexSessionId,
      pty_id: null,
      cwd,
      user_label: 'DevNeural Testing',
      derived_label: null,
      mode: 'conversation',
      status: 'ended',
      started_ms: Date.now() - 7200_000,
      ended_ms: Date.now() - 3600_000,
      turn_count: 6,
      topic_tags_json: '[]',
      artifacts_json: '{}',
      last_summary: null,
      last_summary_ms: null,
    });
    db.insertBrainstormChunk({
      id: 'chunk-r1',
      brainstorm_id: bsId,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'retro session content',
      model_id: '',
      no_decay: 1,
    });
    db.close();

    const { Store } = await import('../src/store/index.js');
    const store = await Store.open();

    const { runDistillationFlush } = await import(
      '../src/lex/session-end-pipeline.js'
    );

    await runDistillationFlush(store, {
      brainstormId: bsId,
      claudeSessionId: lexSessionId,
      mode: 'conversation',
      reason: 'admin-redistill',
    });

    const verifyDb = new IndexDb(dbFile);
    const row = verifyDb.getBrainstorm(bsId);
    verifyDb.close();
    expect(row?.status).toBe('ended');
    expect(row?.last_summary).toBe(`stub last_summary for ${bsId}`);
  });
});
