/**
 * Curator-loop revival, root cause R3: no pre-injection vet step.
 *
 * DEVNEURAL_CURATOR_VET (default OFF) gates a judge call that runs after
 * a candidate has already passed the cosine floor and before injection.
 * It reuses the same provider plumbing llmPolish uses (pickProvider /
 * callValidated), races it against a hard timeout
 * (DEVNEURAL_CURATOR_VET_TIMEOUT_MS, 800ms in production), and:
 *   - flag off                -> vet code never runs, byte-identical to today
 *   - provider says veto      -> no injection, curator_log row decision='vetoed'
 *   - provider times out      -> falls back to inject (hook must never block)
 *   - provider errors         -> falls back to inject
 *
 * The embedder and wikiPages/rawChunks vector stores are faked so these
 * tests exercise curate()'s actual decision logic without depending on
 * the real Xenova embedding pipeline or a populated HNSW index. The LLM
 * provider is faked at pickProvider() so callValidated's real JSON
 * parse/validate/retry logic still runs on top of a controllable
 * `.call()` response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let priorRoot: string | undefined;
let priorVet: string | undefined;
let priorVetTimeout: string | undefined;
let priorCuratorLlm: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs
    .mkdtempSync(path.join(os.tmpdir(), 'devneural-vet-'))
    .replace(/\\/g, '/');
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'projects'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  priorVet = process.env.DEVNEURAL_CURATOR_VET;
  priorVetTimeout = process.env.DEVNEURAL_CURATOR_VET_TIMEOUT_MS;
  priorCuratorLlm = process.env.DEVNEURAL_CURATOR_LLM;
  delete process.env.DEVNEURAL_CURATOR_VET;
  delete process.env.DEVNEURAL_CURATOR_VET_TIMEOUT_MS;
  delete process.env.DEVNEURAL_CURATOR_LLM;

  const { IndexDb } = await import('../src/store/index-db.js');
  const bootstrap = new IndexDb(dbFile);
  bootstrap.close();
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  if (priorVet === undefined) delete process.env.DEVNEURAL_CURATOR_VET;
  else process.env.DEVNEURAL_CURATOR_VET = priorVet;
  if (priorVetTimeout === undefined) delete process.env.DEVNEURAL_CURATOR_VET_TIMEOUT_MS;
  else process.env.DEVNEURAL_CURATOR_VET_TIMEOUT_MS = priorVetTimeout;
  if (priorCuratorLlm === undefined) delete process.env.DEVNEURAL_CURATOR_LLM;
  else process.env.DEVNEURAL_CURATOR_LLM = priorCuratorLlm;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

function mockEmbedder(): void {
  vi.doMock('../src/embedder/index.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/embedder/index.js')>();
    return { ...orig, embedOne: async () => new Float32Array([1, 0, 0]) };
  });
}

/** Fake LlmProvider. `.call` is a vi.fn so each test controls its response. */
function mockProvider(callImpl: (...args: unknown[]) => Promise<unknown>): ReturnType<typeof vi.fn> {
  const callFn = vi.fn(callImpl);
  vi.doMock('../src/llm/index.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/llm/index.js')>();
    return {
      ...orig,
      pickProvider: () => ({
        name: 'fake',
        description: 'fake test provider',
        isConfigured: () => true,
        configHint: () => '',
        modelIds: () => ({
          ingest: 'fake',
          lint: 'fake',
          reconcile: 'fake',
          selfQuery: 'fake',
          distillation: 'fake',
        }),
        call: callFn,
      }),
    };
  });
  return callFn;
}

function wikiHitStore(db: import('../src/store/index-db.js').IndexDb) {
  return {
    db,
    wikiPages: {
      size: () => 1,
      search: () => [
        {
          id: 'vet-wiki-page',
          score: 0.9,
          metadata: {
            status: 'canonical',
            weight: 0.5,
            trigger: 'vet trigger',
            insight: 'vet insight',
            title: 'vet trigger → vet insight',
          },
        },
      ],
    },
    rawChunks: { size: () => 0, search: () => [] },
  } as unknown as import('../src/store/index.js').Store;
}

function rawFallbackStore(db: import('../src/store/index-db.js').IndexDb) {
  return {
    db,
    wikiPages: { size: () => 0, search: () => [] },
    rawChunks: {
      size: () => 1,
      search: () => [
        {
          id: 'vet-raw-chunk',
          score: 0.9,
          metadata: {
            project_id: 'proj-vet',
            text_preview: 'a raw transcript chunk preview well over forty characters long',
          },
        },
      ],
    },
  } as unknown as import('../src/store/index.js').Store;
}

describe('R3 vet gate: flag off is byte-identical to today', () => {
  it('wiki-hit candidate flow: injects, never calls the provider', async () => {
    mockEmbedder();
    const callFn = mockProvider(async () => {
      throw new Error('must not be called when vet is off');
    });
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    const { curate } = await import('../src/curation/curator.js');

    const result = await curate(wikiHitStore(db), {
      prompt: 'how does the connection pooling code work in this service',
      sessionId: 'sess-vetoff-1',
      projectId: 'proj-vet',
    });

    expect(result.injection).toContain('vet-wiki-page');
    expect(result.components.skipped_reason).toBeUndefined();
    expect(callFn).not.toHaveBeenCalled();

    const row = db['db']
      .prepare(`SELECT decision FROM curator_log WHERE prompt_id = ?`)
      .get(result.prompt_id) as { decision: string } | undefined;
    expect(row?.decision).toBe('inject');

    db.close();
  });

  it('raw-fallback candidate flow: injects, never calls the provider', async () => {
    mockEmbedder();
    const callFn = mockProvider(async () => {
      throw new Error('must not be called when vet is off');
    });
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    const { curate } = await import('../src/curation/curator.js');

    const result = await curate(rawFallbackStore(db), {
      prompt: 'what did we decide about the raw transcript fallback threshold',
      sessionId: 'sess-vetoff-2',
      projectId: 'proj-vet',
    });

    expect(result.injection).toContain('vet-raw-chunk');
    expect(result.components.skipped_reason).toBeUndefined();
    expect(callFn).not.toHaveBeenCalled();

    const row = db['db']
      .prepare(`SELECT decision FROM curator_log WHERE prompt_id = ?`)
      .get(result.prompt_id) as { decision: string } | undefined;
    expect(row?.decision).toBe('inject');

    db.close();
  });
});

describe('R3 vet gate: on + provider veto', () => {
  it('suppresses the injection and logs decision=vetoed', async () => {
    process.env.DEVNEURAL_CURATOR_VET = '1';
    mockEmbedder();
    mockProvider(async () => ({
      text: JSON.stringify({ decision: 'veto', reason: 'stale, does not match the prompt' }),
      inputTokens: 10,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelId: 'fake',
      providerName: 'fake',
    }));
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    const { curate } = await import('../src/curation/curator.js');
    const reinforcement = await import('../src/reinforcement/index.js');

    const result = await curate(wikiHitStore(db), {
      prompt: 'how does the connection pooling code work in this service',
      sessionId: 'sess-veto-1',
      projectId: 'proj-vet',
    });

    expect(result.injection).toBe('');
    expect(result.components.skipped_reason).toBe('vetoed');
    // No injection was recorded for reinforcement to evaluate.
    expect(reinforcement.getPending('sess-veto-1')).toBeNull();

    const row = db['db']
      .prepare(`SELECT decision, page_slug FROM curator_log WHERE prompt_id = ?`)
      .get(result.prompt_id) as { decision: string; page_slug: string | null } | undefined;
    expect(row?.decision).toBe('vetoed');
    expect(row?.page_slug).toBe('vet-wiki-page');

    db.close();
  });
});

describe('R3 vet gate: on + provider timeout falls back to inject', () => {
  it('never resolves in time -> curate() still injects', async () => {
    process.env.DEVNEURAL_CURATOR_VET = '1';
    process.env.DEVNEURAL_CURATOR_VET_TIMEOUT_MS = '40';
    mockEmbedder();
    mockProvider(() => new Promise(() => {
      /* never resolves: forces the internal timeout branch to win */
    }));
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    const { curate } = await import('../src/curation/curator.js');
    const reinforcement = await import('../src/reinforcement/index.js');

    const result = await curate(wikiHitStore(db), {
      prompt: 'how does the connection pooling code work in this service',
      sessionId: 'sess-timeout-1',
      projectId: 'proj-vet',
    });

    expect(result.injection).toContain('vet-wiki-page');
    expect(result.components.skipped_reason).toBeUndefined();
    expect(reinforcement.getPending('sess-timeout-1')).not.toBeNull();

    const row = db['db']
      .prepare(`SELECT decision FROM curator_log WHERE prompt_id = ?`)
      .get(result.prompt_id) as { decision: string } | undefined;
    expect(row?.decision).toBe('inject');

    db.close();
  }, 10000);
});

describe('R3 vet gate: on + provider error falls back to inject', () => {
  it('provider.call rejects -> curate() still injects', async () => {
    process.env.DEVNEURAL_CURATOR_VET = '1';
    process.env.DEVNEURAL_CURATOR_VET_TIMEOUT_MS = '400';
    mockEmbedder();
    mockProvider(async () => {
      throw new Error('simulated provider outage');
    });
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    const { curate } = await import('../src/curation/curator.js');

    const result = await curate(wikiHitStore(db), {
      prompt: 'how does the connection pooling code work in this service',
      sessionId: 'sess-error-1',
      projectId: 'proj-vet',
    });

    expect(result.injection).toContain('vet-wiki-page');
    expect(result.components.skipped_reason).toBeUndefined();

    const row = db['db']
      .prepare(`SELECT decision FROM curator_log WHERE prompt_id = ?`)
      .get(result.prompt_id) as { decision: string } | undefined;
    expect(row?.decision).toBe('inject');

    db.close();
  });
});
