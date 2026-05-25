/**
 * Regression test for Fix 2026-05-24, updated for Stage 2 of
 * LEX-AUTONOMY-PAYLOAD-SPEC. After Stage 2 the canonical session-end
 * path writes per-session ref_summary onto lex_transcript_ref FIRST,
 * then recomposes brainstorm_sessions.last_summary as a deterministic
 * concat of the N newest ref_summaries on the same anchor. These
 * tests still assert last_summary lands; the mechanism changed but
 * the user-visible guarantee did not.
 *
 * Stubs both distillation generators via vi.mock so the test never
 * hits ollama:
 *   - createLlmDistillationGenerator (anchor-flat, legacy) still
 *     returns a stub string for any callers still on that surface.
 *   - createPerSessionDistillationGenerator (Stage 2) returns the
 *     {summary, provenance} shape the new wiring expects.
 *
 * The seed adds the Stage 0 prerequisites (lex_session row,
 * lex_transcript_ref row keyed by cc_session_id, brainstorm_chunks
 * with cc_session_id stamped) so the per-session path's "no_session_
 * scoped_chunks" guard does NOT fire and the writer reaches the
 * updateLexTranscriptRef + rolling aggregate steps.
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
    createPerSessionDistillationGenerator: () => async (input: {
      brainstorm_id: string;
      cc_session_id: string;
      totalChunksInSession: number;
    }) => ({
      summary: `stub ref_summary for ${input.brainstorm_id}`,
      source_chunk_count: input.totalChunksInSession,
      source_session_ids: JSON.stringify([input.cc_session_id]),
      coverage_score: 1,
    }),
    SYSTEM_BLOCK: { text: 'stub', cache: false },
    PER_SESSION_SYSTEM_BLOCK: { text: 'stub', cache: false },
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

    /* Stage 0 substrate: lex_session row (brainstorm_id ==
     * lex_session id per migration-018 contract) + matching
     * lex_transcript_ref row keyed by cc_session_id. The Stage 2
     * writer looks up the ref by cc_session_id and updates it in
     * place; without the ref row, the per-session path logs "no
     * lex_transcript_ref" and skips. */
    db.insertLexSession({
      id: bsId,
      created_ms: Date.now() - 60_000,
      title: 'attached',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd,
    });
    db.insertLexTranscriptRef({
      lex_session_id: bsId,
      cc_session_id: lexSessionId,
      transcript_path: '/synthetic/attached-test/cc.jsonl',
      started_ms: Date.now() - 60_000,
      ended_ms: null,
      ordering: 0,
    });

    /* cc_session_id MUST be stamped (Stage 0 contract) for the
     * per-session scoped read to find these rows. */
    db.insertBrainstormChunk({
      id: 'chunk-user-1',
      brainstorm_id: bsId,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'lets discuss the cold-start preload bug',
      model_id: '',
      no_decay: 1,
      cc_session_id: lexSessionId,
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
      cc_session_id: lexSessionId,
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
    /* The rolling aggregate stitches per-session ref_summaries with
     * `## Session <cc-id-short> (<iso>)` headers; assert presence
     * of the stub payload + the cc id short prefix rather than the
     * exact literal so a separator/header tweak does not break this
     * regression guard. */
    expect(row).not.toBeNull();
    expect(row?.attached_worker_session_id).toBe(workerSessionId);
    expect(row?.last_summary).toContain(`stub ref_summary for ${bsId}`);
    expect(row?.last_summary).toContain(lexSessionId.slice(0, 8));
    expect(row?.last_summary_ms ?? 0).toBeGreaterThan(0);
    /* Per-session artifact also landed on the ref row. */
    const ref = verifyDb.getLexTranscriptRefByCc(lexSessionId);
    verifyDb.close();
    expect(ref?.ref_summary).toBe(`stub ref_summary for ${bsId}`);
    expect(ref?.ref_summary_ms ?? 0).toBeGreaterThan(0);
    expect(ref?.coverage_score).toBe(1);
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
    db.insertLexSession({
      id: bsId,
      created_ms: Date.now() - 7200_000,
      title: 'retro',
      derived_title: null,
      status: 'dormant',
      current_pty_id: null,
      cwd,
    });
    db.insertLexTranscriptRef({
      lex_session_id: bsId,
      cc_session_id: lexSessionId,
      transcript_path: '/synthetic/retro-test/cc.jsonl',
      started_ms: Date.now() - 7200_000,
      ended_ms: Date.now() - 3600_000,
      ordering: 0,
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
      cc_session_id: lexSessionId,
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
    expect(row?.last_summary).toContain(`stub ref_summary for ${bsId}`);
  });
});
