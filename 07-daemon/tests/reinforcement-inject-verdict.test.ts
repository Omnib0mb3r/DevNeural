/**
 * Explicit inject-verdict wiring: evaluateAssistantReply (src/
 * reinforcement/index.ts) fires the judge (src/reinforcement/
 * inject-verdict.ts) AFTER the existing cosine evaluation, behind
 * DEVNEURAL_INJECT_VERDICT (default off). The cosine path itself is
 * untouched -- these tests assert the *additional* curator_signal row
 * the judge writes, on top of the row the cosine HIT path already
 * writes (see tests/reinforcement-curator-signal.test.ts for cosine-
 * path-only coverage).
 *
 * scheduleInjectVerdict is fire-and-forget from evaluateAssistantReply
 * (the judge must never block the transcript watcher), so
 * evaluateAssistantReply's own returned promise resolves before the
 * judge's background work finishes. Tests that need to observe the
 * judge's row use vi.waitFor to poll for it; tests that assert a row
 * NEVER appears (flag off, timeout) wait out a fixed real-time window
 * instead, since "absence" cannot be polled for.
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
let priorVerdict: string | undefined;
let priorVerdictTimeout: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs
    .mkdtempSync(path.join(os.tmpdir(), 'devneural-injverdict-'))
    .replace(/\\/g, '/');
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  priorVerdict = process.env.DEVNEURAL_INJECT_VERDICT;
  priorVerdictTimeout = process.env.DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS;
  delete process.env.DEVNEURAL_INJECT_VERDICT;
  delete process.env.DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS;

  const { IndexDb } = await import('../src/store/index-db.js');
  const bootstrap = new IndexDb(dbFile);
  bootstrap.close();
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });

  // Identical unit vector every call -> cosine is always 1.0, well
  // above HIT_COSINE (0.65) regardless of the real text content. Same
  // pattern as tests/reinforcement-curator-signal.test.ts.
  vi.doMock('../src/embedder/index.js', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../src/embedder/index.js')>();
    return { ...orig, embedOne: async () => new Float32Array([1, 0, 0]) };
  });
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  if (priorVerdict === undefined) delete process.env.DEVNEURAL_INJECT_VERDICT;
  else process.env.DEVNEURAL_INJECT_VERDICT = priorVerdict;
  if (priorVerdictTimeout === undefined)
    delete process.env.DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS;
  else process.env.DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS = priorVerdictTimeout;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Fake LlmProvider mocked at pickProvider() -- reinforcement/index.ts
 * calls pickProvider() itself (judgeInjectionUse takes the provider as
 * a plain dependency, but scheduleInjectVerdict resolves it via the
 * same module curator.ts's vetCandidate uses). Mirrors
 * tests/curator-vet-gate.test.ts's mockProvider helper. */
function mockProvider(
  callImpl: (...args: unknown[]) => Promise<unknown>,
): ReturnType<typeof vi.fn> {
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

function fakeCallResult(text: string): Record<string, unknown> {
  return {
    text,
    inputTokens: 10,
    outputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelId: 'fake',
    providerName: 'fake',
  };
}

async function buildStore(dbFilePath: string): Promise<{
  store: import('../src/store/index.js').Store;
  db: import('../src/store/index-db.js').IndexDb;
}> {
  const { IndexDb } = await import('../src/store/index-db.js');
  const db = new IndexDb(dbFilePath);
  const store = {
    db,
    wikiPages: { add: async () => undefined },
  } as unknown as import('../src/store/index.js').Store;
  return { store, db };
}

/** Plants one curator_log row + a raw-kind pending injection (simpler
 * fixture than a wiki page: no on-disk wiki file needed, and the
 * cosine HIT branch's scheduleRawHitIngest bails immediately because
 * rawText is under the 40-char floor -- see
 * tests/reinforcement-curator-signal.test.ts's identical rationale). */
async function plantRawPending(
  db: import('../src/store/index-db.js').IndexDb,
  reinforcement: typeof import('../src/reinforcement/index.js'),
  ids: { logId: string; promptId: string; sessionId: string; chunkId: string },
): Promise<void> {
  db.insertCuratorLog({
    id: ids.logId,
    prompt_id: ids.promptId,
    session_id: ids.sessionId,
    project_slug: 'proj-a',
    decision: 'inject',
    page_slug: null,
    score: 0.7,
    threshold: 0.65,
    confidence: 0.14,
    source_class: 'raw',
  });
  reinforcement.recordRawInjection(
    ids.sessionId,
    ids.chunkId,
    'short raw chunk',
    'proj-a',
    ids.logId,
    ids.promptId,
  );
}

describe('inject-verdict wiring: flag off is byte-identical to today', () => {
  it('never calls the provider; only the cosine curator_signal row is written', async () => {
    const callFn = mockProvider(async () => {
      throw new Error('must not be called when DEVNEURAL_INJECT_VERDICT is unset');
    });
    const reinforcement = await import('../src/reinforcement/index.js');
    const { store, db } = await buildStore(dbFile);

    await plantRawPending(db, reinforcement, {
      logId: 'log-off',
      promptId: 'prompt-off',
      sessionId: 'sess-off',
      chunkId: 'chunk-off',
    });

    await reinforcement.evaluateAssistantReply(
      store,
      'sess-off',
      'a'.repeat(100),
      () => undefined,
    );

    // Real-time settle window: proves no background judge call ever
    // fires, not just that none had fired yet at await-time.
    await new Promise((r) => setTimeout(r, 150));

    expect(callFn).not.toHaveBeenCalled();
    const rows = db['db']
      .prepare(`SELECT * FROM curator_signal WHERE curator_log_id = ?`)
      .all('log-off') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.source).toBe('regex-inferred');

    db.close();
  });
});

describe('inject-verdict wiring: flag on + verdict "used"', () => {
  it('writes an additional curator_signal hit row with source=llm-judge', async () => {
    process.env.DEVNEURAL_INJECT_VERDICT = '1';
    mockProvider(async () =>
      fakeCallResult(
        JSON.stringify({ verdict: 'used', reason: 'reply applies the injected chunk' }),
      ),
    );
    const reinforcement = await import('../src/reinforcement/index.js');
    const { store, db } = await buildStore(dbFile);

    await plantRawPending(db, reinforcement, {
      logId: 'log-used',
      promptId: 'prompt-used',
      sessionId: 'sess-used',
      chunkId: 'chunk-used',
    });

    await reinforcement.evaluateAssistantReply(
      store,
      'sess-used',
      'a'.repeat(100),
      () => undefined,
    );

    await vi.waitFor(
      () => {
        const rows = db['db']
          .prepare(`SELECT * FROM curator_signal WHERE curator_log_id = ?`)
          .all('log-used') as Array<Record<string, unknown>>;
        expect(rows.length).toBe(2);
      },
      { timeout: 2000, interval: 20 },
    );

    const rows = db['db']
      .prepare(`SELECT * FROM curator_signal WHERE curator_log_id = ? ORDER BY source`)
      .all('log-used') as Array<Record<string, unknown>>;
    const judgeRow = rows.find((r) => r.source === 'llm-judge');
    expect(judgeRow?.signal).toBe('hit');
    expect(judgeRow?.prompt_id).toBe('prompt-used');
    const cosineRow = rows.find((r) => r.source === 'regex-inferred');
    expect(cosineRow?.signal).toBe('hit');

    db.close();
  });
});

describe('inject-verdict wiring: flag on + verdict "ignored"', () => {
  it('writes an additional curator_signal wrong row with source=llm-judge', async () => {
    process.env.DEVNEURAL_INJECT_VERDICT = '1';
    mockProvider(async () =>
      fakeCallResult(
        JSON.stringify({ verdict: 'ignored', reason: 'reply never touches the chunk' }),
      ),
    );
    const reinforcement = await import('../src/reinforcement/index.js');
    const { store, db } = await buildStore(dbFile);

    await plantRawPending(db, reinforcement, {
      logId: 'log-ignored',
      promptId: 'prompt-ignored',
      sessionId: 'sess-ignored',
      chunkId: 'chunk-ignored',
    });

    await reinforcement.evaluateAssistantReply(
      store,
      'sess-ignored',
      'a'.repeat(100),
      () => undefined,
    );

    await vi.waitFor(
      () => {
        const rows = db['db']
          .prepare(`SELECT * FROM curator_signal WHERE curator_log_id = ?`)
          .all('log-ignored') as Array<Record<string, unknown>>;
        expect(rows.length).toBe(2);
      },
      { timeout: 2000, interval: 20 },
    );

    const rows = db['db']
      .prepare(`SELECT * FROM curator_signal WHERE curator_log_id = ?`)
      .all('log-ignored') as Array<Record<string, unknown>>;
    const judgeRow = rows.find((r) => r.source === 'llm-judge');
    expect(judgeRow?.signal).toBe('wrong');

    db.close();
  });
});

describe('inject-verdict wiring: flag on + provider timeout', () => {
  it('never resolves in time -> no llm-judge row is ever written', async () => {
    process.env.DEVNEURAL_INJECT_VERDICT = '1';
    process.env.DEVNEURAL_INJECT_VERDICT_TIMEOUT_MS = '40';
    mockProvider(
      () =>
        new Promise(() => {
          /* never resolves: forces the internal timeout branch to win */
        }),
    );
    const reinforcement = await import('../src/reinforcement/index.js');
    const { store, db } = await buildStore(dbFile);

    await plantRawPending(db, reinforcement, {
      logId: 'log-timeout',
      promptId: 'prompt-timeout',
      sessionId: 'sess-timeout',
      chunkId: 'chunk-timeout',
    });

    await reinforcement.evaluateAssistantReply(
      store,
      'sess-timeout',
      'a'.repeat(100),
      () => undefined,
    );

    // Wait well past the 40ms internal timeout, then assert the
    // llm-judge row was never written (an 'unclear' verdict writes
    // nothing -- see scheduleInjectVerdict's doc comment).
    await new Promise((r) => setTimeout(r, 300));

    const rows = db['db']
      .prepare(`SELECT * FROM curator_signal WHERE curator_log_id = ?`)
      .all('log-timeout') as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.source).toBe('regex-inferred');

    db.close();
  }, 10000);
});
