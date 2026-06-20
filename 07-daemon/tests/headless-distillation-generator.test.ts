/**
 * Headless Opus distillation generator (sliver 2b).
 *
 * Verifies createHeadlessDistillationGenerator drives the shared
 * `claude -p` engine (injected stub) through the SAME prompt + cleanup
 * + fail-safe contract as the ollama path, so the engine swap is
 * content-equivalent and the backfill's selection/stamping is
 * unchanged. The real spawn is never exercised here (stub injected);
 * its fallback behaviour is the headless-opus primitive's contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  createHeadlessDistillationGenerator,
  createHeadlessPerSessionDistillationGenerator,
  selectAnchorFlatGenerator,
  selectPerSessionGenerator,
} from '../src/lex/distillation-generator.js';
import type { CallResult, LlmProvider } from '../src/llm/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

function insertBs(opts: { id: string; started_ms: number }): void {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/p/lex',
    user_label: 'Headless Distill',
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-distill-headless-'));
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

describe('createHeadlessDistillationGenerator', () => {
  it('returns the cleaned engine reply when chunks exist', async () => {
    insertBs({ id: 'bs-1', started_ms: 1_000 });
    insertChunk({
      id: 'c-1',
      brainstormId: 'bs-1',
      turn: 0,
      role: 'user',
      text: 'shipped the headless engine extraction tonight',
    });
    const spawnHeadless = vi.fn(async () => '  "neat summary"  ');
    const generator = createHeadlessDistillationGenerator({
      db,
      spawnHeadless,
    });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    const out = await generator(row);
    /* Surrounding quotes stripped, same cleanup as the ollama path. */
    expect(out).toBe('neat summary');
    expect(spawnHeadless).toHaveBeenCalledTimes(1);
  });

  it('ships the structured SYSTEM_BLOCK prompt + the transcript to claude -p', async () => {
    insertBs({ id: 'bs-prompt', started_ms: 1_000 });
    insertChunk({
      id: 'c-pp',
      brainstormId: 'bs-prompt',
      turn: 0,
      role: 'user',
      text: 'distinctive-transcript-marker',
    });
    let capturedPrompt = '';
    let capturedTimeout = 0;
    const spawnHeadless = vi.fn(
      async (prompt: string, _cwd: string, timeoutMs: number) => {
        capturedPrompt = prompt;
        capturedTimeout = timeoutMs;
        return 'summary';
      },
    );
    const generator = createHeadlessDistillationGenerator({
      db,
      spawnHeadless,
      timeoutMs: 12_345,
    });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    await generator(row);
    expect(capturedPrompt).toMatch(/pick up where this one left off/);
    expect(capturedPrompt.toLowerCase()).toMatch(/key decisions/);
    expect(capturedPrompt).toContain('--- TRANSCRIPT ---');
    expect(capturedPrompt).toContain('distinctive-transcript-marker');
    expect(capturedTimeout).toBe(12_345);
  });

  it('returns null when the engine yields null (fail-safe)', async () => {
    insertBs({ id: 'bs-1', started_ms: 1_000 });
    insertChunk({
      id: 'c-1',
      brainstormId: 'bs-1',
      turn: 0,
      role: 'user',
      text: 'anything',
    });
    const generator = createHeadlessDistillationGenerator({
      db,
      spawnHeadless: async () => null,
    });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    expect(await generator(row)).toBeNull();
  });

  it('returns null when the engine reply is empty/whitespace', async () => {
    insertBs({ id: 'bs-1', started_ms: 1_000 });
    insertChunk({
      id: 'c-1',
      brainstormId: 'bs-1',
      turn: 0,
      role: 'user',
      text: 'anything',
    });
    const generator = createHeadlessDistillationGenerator({
      db,
      spawnHeadless: async () => '   \n  ',
    });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    expect(await generator(row)).toBeNull();
  });

  it('catches a spawn throw and returns null', async () => {
    insertBs({ id: 'bs-1', started_ms: 1_000 });
    insertChunk({
      id: 'c-1',
      brainstormId: 'bs-1',
      turn: 0,
      role: 'user',
      text: 'hi',
    });
    const generator = createHeadlessDistillationGenerator({
      db,
      spawnHeadless: vi.fn().mockRejectedValue(new Error('claude missing')),
    });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    expect(await generator(row)).toBeNull();
  });

  it('returns null and never spawns when there is no distillable source', async () => {
    insertBs({ id: 'bs-bare', started_ms: 1_000 });
    const spawnHeadless = vi.fn(async () => 'should not run');
    const generator = createHeadlessDistillationGenerator({
      db,
      spawnHeadless,
    });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    expect(await generator(row)).toBeNull();
    expect(spawnHeadless).not.toHaveBeenCalled();
  });

  it('ships the NEWEST chunkLimit chunks in chronological order (parity with ollama path)', async () => {
    insertBs({ id: 'bs-order', started_ms: 1_000 });
    for (let i = 0; i < 100; i++) {
      insertChunk({
        id: `c-${i}`,
        brainstormId: 'bs-order',
        turn: i,
        role: i % 2 === 0 ? 'user' : 'lex',
        text: `turn-${i}`,
      });
    }
    let capturedPrompt = '';
    const generator = createHeadlessDistillationGenerator({
      db,
      chunkLimit: 50,
      spawnHeadless: async (prompt: string) => {
        capturedPrompt = prompt;
        return 'summary';
      },
    });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    await generator(row);
    expect(capturedPrompt).toContain('turn-99');
    expect(capturedPrompt).toContain('turn-50');
    expect(capturedPrompt).not.toContain('turn-0\n');
    expect(capturedPrompt.indexOf('turn-50')).toBeLessThan(
      capturedPrompt.indexOf('turn-99'),
    );
  });
});

function insertCcChunk(opts: {
  id: string;
  brainstormId: string;
  ccSessionId: string;
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
    model_id: opts.role === 'lex' ? 'claude' : '',
    no_decay: 1,
    cc_session_id: opts.ccSessionId,
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
        text: (opts.respond ?? (() => 'ollama summary'))(callOpts.user),
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

describe('createHeadlessPerSessionDistillationGenerator', () => {
  it('returns summary + provenance from the engine for a scoped session', async () => {
    insertBs({ id: 'bs-ps', started_ms: 1_000 });
    insertCcChunk({
      id: 'cc1-0',
      brainstormId: 'bs-ps',
      ccSessionId: 'cc-1',
      turn: 0,
      role: 'user',
      text: 'session-one content marker',
    });
    let capturedPrompt = '';
    const gen = createHeadlessPerSessionDistillationGenerator({
      db,
      spawnHeadless: async (prompt: string) => {
        capturedPrompt = prompt;
        return '  "per-session summary"  ';
      },
    });
    const out = await gen({
      brainstorm_id: 'bs-ps',
      cc_session_id: 'cc-1',
      totalChunksInSession: 1,
    });
    expect(out).not.toBeNull();
    expect(out!.summary).toBe('per-session summary');
    expect(out!.source_chunk_count).toBe(1);
    expect(out!.source_session_ids).toBe(JSON.stringify(['cc-1']));
    expect(out!.coverage_score).toBe(1);
    /* Per-session system block + transcript reach the engine. */
    expect(capturedPrompt.toLowerCase()).toMatch(/session topic/);
    expect(capturedPrompt).toContain('session-one content marker');
  });

  it('isolates chunks by cc_session_id (no leak across sessions)', async () => {
    insertBs({ id: 'bs-iso', started_ms: 1_000 });
    insertCcChunk({
      id: 'a-0',
      brainstormId: 'bs-iso',
      ccSessionId: 'cc-a',
      turn: 0,
      role: 'user',
      text: 'ALPHA-only-text',
    });
    insertCcChunk({
      id: 'b-0',
      brainstormId: 'bs-iso',
      ccSessionId: 'cc-b',
      turn: 1,
      role: 'user',
      text: 'BETA-only-text',
    });
    let capturedPrompt = '';
    const gen = createHeadlessPerSessionDistillationGenerator({
      db,
      spawnHeadless: async (p: string) => {
        capturedPrompt = p;
        return 'ok';
      },
    });
    await gen({
      brainstorm_id: 'bs-iso',
      cc_session_id: 'cc-a',
      totalChunksInSession: 1,
    });
    expect(capturedPrompt).toContain('ALPHA-only-text');
    expect(capturedPrompt).not.toContain('BETA-only-text');
  });

  it('returns null with no spawn when the session has no scoped chunks', async () => {
    insertBs({ id: 'bs-empty', started_ms: 1_000 });
    const spawnHeadless = vi.fn(async () => 'should not run');
    const gen = createHeadlessPerSessionDistillationGenerator({
      db,
      spawnHeadless,
    });
    const out = await gen({
      brainstorm_id: 'bs-empty',
      cc_session_id: 'cc-none',
      totalChunksInSession: 0,
    });
    expect(out).toBeNull();
    expect(spawnHeadless).not.toHaveBeenCalled();
  });

  it('returns null when the engine yields null or throws', async () => {
    insertBs({ id: 'bs-fail', started_ms: 1_000 });
    insertCcChunk({
      id: 'f-0',
      brainstormId: 'bs-fail',
      ccSessionId: 'cc-f',
      turn: 0,
      role: 'user',
      text: 'content',
    });
    const nullGen = createHeadlessPerSessionDistillationGenerator({
      db,
      spawnHeadless: async () => null,
    });
    expect(
      await nullGen({
        brainstorm_id: 'bs-fail',
        cc_session_id: 'cc-f',
        totalChunksInSession: 1,
      }),
    ).toBeNull();
    const throwGen = createHeadlessPerSessionDistillationGenerator({
      db,
      spawnHeadless: vi.fn().mockRejectedValue(new Error('claude missing')),
    });
    expect(
      await throwGen({
        brainstorm_id: 'bs-fail',
        cc_session_id: 'cc-f',
        totalChunksInSession: 1,
      }),
    ).toBeNull();
  });
});

describe('distill engine selection (flag routing)', () => {
  afterEach(() => {
    delete process.env.DEVNEURAL_DISTILL_HEADLESS;
  });

  it('flag OFF -> anchor-flat uses the ollama provider, not the headless engine', async () => {
    delete process.env.DEVNEURAL_DISTILL_HEADLESS;
    insertBs({ id: 'bs-sel', started_ms: 1_000 });
    insertChunk({
      id: 'c-0',
      brainstormId: 'bs-sel',
      turn: 0,
      role: 'user',
      text: 'content',
    });
    const provider = stubProvider({ respond: () => 'OLLAMA-OUT' });
    const spawnHeadless = vi.fn(async () => 'HEADLESS-OUT');
    const gen = selectAnchorFlatGenerator({ db, provider, spawnHeadless });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    const out = await gen(row);
    expect(out).toBe('OLLAMA-OUT');
    expect(spawnHeadless).not.toHaveBeenCalled();
    expect(provider.call).toHaveBeenCalledTimes(1);
  });

  it('flag ON -> anchor-flat uses the headless engine, not the provider', async () => {
    process.env.DEVNEURAL_DISTILL_HEADLESS = '1';
    insertBs({ id: 'bs-sel', started_ms: 1_000 });
    insertChunk({
      id: 'c-0',
      brainstormId: 'bs-sel',
      turn: 0,
      role: 'user',
      text: 'content',
    });
    const provider = stubProvider({ respond: () => 'OLLAMA-OUT' });
    const spawnHeadless = vi.fn(async () => 'HEADLESS-OUT');
    const gen = selectAnchorFlatGenerator({ db, provider, spawnHeadless });
    const row = db.listBrainstorms({ limit: 5 })[0]!;
    const out = await gen(row);
    expect(out).toBe('HEADLESS-OUT');
    expect(spawnHeadless).toHaveBeenCalledTimes(1);
    expect(provider.call).not.toHaveBeenCalled();
  });

  it('flag ON -> per-session uses the headless engine, not the provider', async () => {
    process.env.DEVNEURAL_DISTILL_HEADLESS = '1';
    insertBs({ id: 'bs-selps', started_ms: 1_000 });
    insertCcChunk({
      id: 'p-0',
      brainstormId: 'bs-selps',
      ccSessionId: 'cc-ps',
      turn: 0,
      role: 'user',
      text: 'content',
    });
    const provider = stubProvider({ respond: () => 'OLLAMA-OUT' });
    const spawnHeadless = vi.fn(async () => 'HEADLESS-PS');
    const gen = selectPerSessionGenerator({ db, provider, spawnHeadless });
    const out = await gen({
      brainstorm_id: 'bs-selps',
      cc_session_id: 'cc-ps',
      totalChunksInSession: 1,
    });
    expect(out).not.toBeNull();
    expect(out!.summary).toBe('HEADLESS-PS');
    expect(spawnHeadless).toHaveBeenCalledTimes(1);
    expect(provider.call).not.toHaveBeenCalled();
  });
});
