/**
 * Sliver A: session-end distill routed through the shared headless Opus
 * engine behind DEVNEURAL_DISTILL_HEADLESS.
 *
 * Pins that with the flag ON, runSessionEndPipeline's per-session
 * distill runs through the injected headless spawn (not ollama) and the
 * result lands on lex_transcript_ref.ref_summary + the rolling-aggregate
 * last_summary. With the flag OFF the engine is never spawned (the
 * existing ollama path owns it), proving the swap is dormant by default.
 *
 * Mirrors the stage2 per-session seeding so the pipeline takes the
 * per-session branch (raw_chunk -> projectIdBySession non-null).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let priors: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-se-headless-'));
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'EmptyProjectsRoot'), { recursive: true });
  priors = {
    DEVNEURAL_DATA_ROOT: process.env.DEVNEURAL_DATA_ROOT,
    DEVNEURAL_LLM_PROVIDER: process.env.DEVNEURAL_LLM_PROVIDER,
    DEVNEURAL_PROJECTS_ROOT: process.env.DEVNEURAL_PROJECTS_ROOT,
    DEVNEURAL_DISTILL_HEADLESS: process.env.DEVNEURAL_DISTILL_HEADLESS,
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

async function seedAttachedSession(
  dbFile: string,
  opts: { brainstormId: string; ccSessionId: string; projectId: string },
): Promise<void> {
  const { IndexDb } = await import('../src/store/index-db.js');
  const { runMigrations } = await import('../src/db/migrate.js');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  const db = new IndexDb(dbFile);
  db.upsertRawChunk({
    id: `raw-${opts.brainstormId}-${opts.ccSessionId}`,
    project_id: opts.projectId,
    session_id: opts.ccSessionId,
    timestamp_ms: Date.now() - 30_000,
    kind: 'text',
    role: 'user',
    byte_length: 16,
  });
  db.insertBrainstorm({
    id: opts.brainstormId,
    claude_session_id: opts.ccSessionId,
    pty_id: null,
    cwd: `/synthetic/${opts.brainstormId}`,
    user_label: 'Sliver A Headless',
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: Date.now() - 60_000,
    ended_ms: null,
    turn_count: 2,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
  db.insertLexSession({
    id: opts.brainstormId,
    created_ms: Date.now() - 60_000,
    title: opts.brainstormId,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: `/synthetic/${opts.brainstormId}`,
  });
  db.insertLexTranscriptRef({
    lex_session_id: opts.brainstormId,
    cc_session_id: opts.ccSessionId,
    transcript_path: `/synthetic/${opts.brainstormId}/${opts.ccSessionId}.jsonl`,
    started_ms: Date.now() - 60_000,
    ended_ms: null,
    ordering: 0,
  });
  ['user turn one', 'lex turn one'].forEach((t, i) => {
    db.insertBrainstormChunk({
      id: `chunk-${opts.ccSessionId}-${i}`,
      brainstorm_id: opts.brainstormId,
      turn_index: i + db.nextTurnIndex(opts.brainstormId),
      role: i % 2 === 0 ? 'user' : 'lex',
      mode: 'conversation',
      text: t,
      model_id: i % 2 === 0 ? '' : 'claude',
      no_decay: 1,
      cc_session_id: opts.ccSessionId,
    });
  });
  db.close();
}

describe('session-end engine swap (DEVNEURAL_DISTILL_HEADLESS)', () => {
  it('flag ON: per-session distill runs through the injected headless engine', async () => {
    process.env.DEVNEURAL_DISTILL_HEADLESS = '1';
    const dbFile = path.join(tmpDir, 'index.db');
    await seedAttachedSession(dbFile, {
      brainstormId: 'bs-h1',
      ccSessionId: 'cc-h1',
      projectId: 'p-h1',
    });
    const { Store } = await import('../src/store/index.js');
    const store = await Store.open();
    const { runSessionEndPipeline } = await import(
      '../src/lex/session-end-pipeline.js'
    );
    const spawnHeadless = vi.fn(async () => 'HEADLESS REF SUMMARY via claude -p');
    await runSessionEndPipeline(
      store,
      {
        brainstormId: 'bs-h1',
        claudeSessionId: 'cc-h1',
        mode: 'conversation',
        reason: 'pty-exit',
      },
      () => undefined,
      { spawnHeadless },
    );
    expect(spawnHeadless).toHaveBeenCalled();
    const { IndexDb } = await import('../src/store/index-db.js');
    const verify = new IndexDb(dbFile);
    const ref = verify.getLexTranscriptRefByCc('cc-h1');
    expect(ref?.ref_summary).toBe('HEADLESS REF SUMMARY via claude -p');
    const bs = verify.getBrainstorm('bs-h1');
    /* Rolling aggregate composed last_summary from the headless ref. */
    expect(bs?.last_summary).toContain('HEADLESS REF SUMMARY via claude -p');
    verify.close();
  });

  it('flag OFF: the headless engine is never spawned (ollama owns the path)', async () => {
    delete process.env.DEVNEURAL_DISTILL_HEADLESS;
    const dbFile = path.join(tmpDir, 'index.db');
    await seedAttachedSession(dbFile, {
      brainstormId: 'bs-h2',
      ccSessionId: 'cc-h2',
      projectId: 'p-h2',
    });
    const { Store } = await import('../src/store/index.js');
    const store = await Store.open();
    const { runSessionEndPipeline } = await import(
      '../src/lex/session-end-pipeline.js'
    );
    const spawnHeadless = vi.fn(async () => 'should never run');
    await runSessionEndPipeline(
      store,
      {
        brainstormId: 'bs-h2',
        claudeSessionId: 'cc-h2',
        mode: 'conversation',
        reason: 'pty-exit',
      },
      () => undefined,
      { spawnHeadless },
    );
    expect(spawnHeadless).not.toHaveBeenCalled();
  });
});
