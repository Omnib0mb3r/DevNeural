/**
 * LLM-backed distillation generator + backfill scheduler integration.
 *
 * Wires createLlmDistillationGenerator into runDistillationBackfill via
 * a stub LlmProvider so the test exercises the full path (db chunks ->
 * prompt -> response -> last_summary stamp) without an ollama hit.
 *
 * Headline scenario: 7 sessions with null last_summary, run the
 * backfill once with N=5, only 5 get distilled and hit_cap=true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLlmDistillationGenerator } from '../src/lex/distillation-generator.js';
import { runDistillationBackfill } from '../src/lex/sibling-distillation-backfill.js';
import type { LlmProvider, CallResult } from '../src/llm/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

function insertBs(opts: {
  id: string;
  started_ms: number;
}): void {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/p/lex',
    user_label: 'Mass Backfill',
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: opts.started_ms,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
}

function insertChunk(opts: {
  id: string;
  brainstormId: string;
  turn: number;
  role: 'user' | 'lex';
  text: string;
}): void {
  db.insertBrainstormChunk({
    id: opts.id,
    brainstorm_id: opts.brainstormId,
    turn_index: opts.turn,
    role: opts.role,
    mode: 'conversation',
    text: opts.text,
    model_id: 'qwen3:8b',
    no_decay: 0,
    created_at: new Date(opts.turn * 1000).toISOString(),
  });
}

function stubProvider(opts: {
  name?: string;
  configured?: boolean;
  respond?: (user: string) => string;
}): LlmProvider {
  return {
    name: opts.name ?? 'ollama',
    description: 'stub',
    isConfigured: () => opts.configured ?? true,
    configHint: () => '',
    modelIds: () => ({
      ingest: 'stub',
      lint: 'stub',
      reconcile: 'stub',
      selfQuery: 'stub',
      distillation: 'stub',
    }),
    call: vi.fn(
      async (_role, callOpts): Promise<CallResult> => ({
        text: (opts.respond ?? (() => 'one sentence summary'))(callOpts.user),
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        modelId: 'stub',
        providerName: opts.name ?? 'ollama',
      }),
    ),
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-distill-gen-'));
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

describe('createLlmDistillationGenerator', () => {
  it('returns the trimmed provider text when chunks exist', async () => {
    insertBs({ id: 'bs-1', started_ms: 1_000 });
    insertChunk({
      id: 'c-1',
      brainstormId: 'bs-1',
      turn: 0,
      role: 'user',
      text: 'shipped EDS plus brainstorm threading tonight',
    });
    const provider = stubProvider({ respond: () => '  "neat summary"  ' });
    const generator = createLlmDistillationGenerator({ db, provider });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    const out = await generator(row);
    expect(out).toBe('neat summary');
  });

  it('ships the 3-4 line cold-start handoff prompt + role=distillation', async () => {
    insertBs({ id: 'bs-prompt', started_ms: 1_000 });
    insertChunk({
      id: 'c-pp',
      brainstormId: 'bs-prompt',
      turn: 0,
      role: 'user',
      text: 'transcript content',
    });
    const provider = stubProvider({});
    const generator = createLlmDistillationGenerator({ db, provider });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    await generator(row);
    const callMock = provider.call as ReturnType<typeof vi.fn>;
    expect(callMock).toHaveBeenCalledTimes(1);
    const [role, callOpts] = callMock.mock.calls[0]!;
    expect(role).toBe('distillation');
    const systemText = (callOpts as { systemBlocks: { text: string }[] })
      .systemBlocks[0]!.text;
    expect(systemText).toMatch(/pick up where this one left off/);
    expect(systemText).toMatch(/line 1 the headline topic/);
    expect(systemText).toMatch(/line 2 the most recent concrete decision/);
    expect(systemText).toMatch(/line 3 the open questions/);
    expect(systemText).toMatch(/under 80 words/);
    expect((callOpts as { maxTokens: number }).maxTokens).toBeGreaterThanOrEqual(
      160,
    );
  });

  it('returns null when the provider is not configured', async () => {
    insertBs({ id: 'bs-1', started_ms: 1_000 });
    insertChunk({
      id: 'c-1',
      brainstormId: 'bs-1',
      turn: 0,
      role: 'user',
      text: 'anything',
    });
    const provider = stubProvider({ configured: false });
    const generator = createLlmDistillationGenerator({ db, provider });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    expect(await generator(row)).toBeNull();
    expect(provider.call).not.toHaveBeenCalled();
  });

  it('refuses anthropic (BF-4 outbound block)', async () => {
    insertBs({ id: 'bs-1', started_ms: 1_000 });
    insertChunk({
      id: 'c-1',
      brainstormId: 'bs-1',
      turn: 0,
      role: 'user',
      text: 'secret-ish',
    });
    const provider = stubProvider({ name: 'anthropic' });
    const generator = createLlmDistillationGenerator({ db, provider });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    expect(await generator(row)).toBeNull();
    expect(provider.call).not.toHaveBeenCalled();
  });

  it('returns null when no chunks are stored for the session', async () => {
    insertBs({ id: 'bs-bare', started_ms: 1_000 });
    const provider = stubProvider({});
    const generator = createLlmDistillationGenerator({ db, provider });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    expect(await generator(row)).toBeNull();
    expect(provider.call).not.toHaveBeenCalled();
  });

  it('catches provider exceptions and returns null', async () => {
    insertBs({ id: 'bs-1', started_ms: 1_000 });
    insertChunk({
      id: 'c-1',
      brainstormId: 'bs-1',
      turn: 0,
      role: 'user',
      text: 'hi',
    });
    const provider: LlmProvider = {
      ...stubProvider({}),
      call: vi.fn().mockRejectedValue(new Error('ollama down')),
    };
    const generator = createLlmDistillationGenerator({ db, provider });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    expect(await generator(row)).toBeNull();
  });
});

describe('backfill scheduler integration', () => {
  it('7 sessions missing last_summary -> N=5 cap, 5 distilled, hit_cap true', async () => {
    /* Seven sessions, each with one user turn so the generator has
     * something to slice. started_ms ascending so most-recent first
     * (DESC) hits the top of the cap. */
    for (let i = 0; i < 7; i++) {
      const bid = `bs-${i.toString().padStart(2, '0')}`;
      insertBs({ id: bid, started_ms: 1_000 + i });
      insertChunk({
        id: `c-${i}`,
        brainstormId: bid,
        turn: 0,
        role: 'user',
        text: `session ${i} content placeholder`,
      });
    }
    const calls: string[] = [];
    const provider = stubProvider({
      respond: (user) => {
        calls.push(user);
        return `summary line for ${user.slice(0, 40)}`;
      },
    });
    const generator = createLlmDistillationGenerator({ db, provider });
    const r = await runDistillationBackfill({
      db,
      generator,
      limit: 5,
      now: () => 9_999,
    });
    expect(r.processed.length).toBe(5);
    expect(r.skipped.length).toBe(2);
    expect(r.errors).toEqual([]);
    expect(r.hit_cap).toBe(true);
    expect(calls.length).toBe(5);
    const rows = db.listBrainstorms({ limit: 50 });
    const withSummary = rows.filter((row) => row.last_summary !== null);
    expect(withSummary.length).toBe(5);
    /* Most-recent five (started_ms 1_001..1_006) won the cap. */
    const processedIds = new Set(r.processed);
    expect(processedIds).toContain('bs-06');
    expect(processedIds).toContain('bs-02');
    expect(processedIds).not.toContain('bs-00');
    expect(processedIds).not.toContain('bs-01');
  });

  it('falls through to skipped when provider is unconfigured', async () => {
    for (let i = 0; i < 3; i++) {
      const bid = `bs-${i}`;
      insertBs({ id: bid, started_ms: 1_000 + i });
      insertChunk({
        id: `c-${i}`,
        brainstormId: bid,
        turn: 0,
        role: 'user',
        text: 'hi',
      });
    }
    const provider = stubProvider({ configured: false });
    const generator = createLlmDistillationGenerator({ db, provider });
    const r = await runDistillationBackfill({
      db,
      generator,
      limit: 5,
    });
    expect(r.processed).toEqual([]);
    expect(r.errors.length).toBe(3);
  });
});
