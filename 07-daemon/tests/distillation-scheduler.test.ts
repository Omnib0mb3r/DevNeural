/**
 * Distillation backfill scheduler integration test.
 *
 * Wires the real runDistillationBackfill module against a stub
 * provider + clock-controlled scheduler; asserts the first tick fires
 * after the configured grace period, processes at most
 * BACKFILL_DEFAULT_LIMIT rows, and that an unconfigured provider
 * skips the schedule entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import type { CallResult, LlmProvider } from '../src/llm/types.js';
import { startDistillationBackfillScheduler } from '../src/lex/distillation-scheduler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

function stubProvider(opts: {
  configured?: boolean;
  name?: string;
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
      async (): Promise<CallResult> => ({
        text: 'topic\ndecision\nopen items',
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

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-distill-sched-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertBs(id: string, startedMs: number): void {
  db.insertBrainstorm({
    id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/p/lex',
    user_label: null,
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: startedMs,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
  /* Add one chunk so the generator does not skip on empty transcript. */
  db.insertBrainstormChunk({
    id: `c-${id}`,
    brainstorm_id: id,
    turn_index: 0,
    role: 'user',
    mode: 'conversation',
    text: 'thinking out loud about the design',
    model_id: 'stub',
    no_decay: 1,
  });
}

describe('startDistillationBackfillScheduler', () => {
  it('processes at most BACKFILL_DEFAULT_LIMIT rows on the first tick', async () => {
    /* Seed 7 candidates so the cap (5) bites. */
    for (let i = 0; i < 7; i++) {
      insertBs(`bs-${i.toString().padStart(2, '0')}`, 1_000 + i);
    }
    const provider = stubProvider({});
    const logs: string[] = [];
    const handle = startDistillationBackfillScheduler({
      db,
      provider,
      log: (m) => logs.push(m),
      firstFireDelayMs: 10,
      intervalMs: 60_000,
    });
    /* Advance just past the first-fire delay; do NOT run pending
     * interval timers or we will stack a second tick on top. */
    await vi.advanceTimersByTimeAsync(15);
    /* Wait for the in-flight tick's microtasks + sync generator
     * calls to drain. */
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
    handle.stop();
    const callMock = provider.call as ReturnType<typeof vi.fn>;
    expect(callMock.mock.calls.length).toBe(5);
    const populated = db
      .listBrainstorms({ limit: 100 })
      .filter((r) => r.last_summary && r.last_summary.length > 0);
    expect(populated.length).toBe(5);
    const tickLog = logs.find((l) => l.includes('processed='));
    expect(tickLog).toMatch(/processed=5/);
    expect(tickLog).toMatch(/hit_cap=true/);
  });

  it('skips the schedule when the provider is not configured', () => {
    const provider = stubProvider({ configured: false });
    const logs: string[] = [];
    const handle = startDistillationBackfillScheduler({
      db,
      provider,
      log: (m) => logs.push(m),
      firstFireDelayMs: 1,
      intervalMs: 60_000,
    });
    handle.stop();
    expect(logs.find((l) => l.includes('not configured'))).toBeTruthy();
    expect((provider.call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      0,
    );
  });

  it('skips the schedule on the anthropic provider (BF-4)', () => {
    const provider = stubProvider({ name: 'anthropic' });
    const logs: string[] = [];
    const handle = startDistillationBackfillScheduler({
      db,
      provider,
      log: (m) => logs.push(m),
      firstFireDelayMs: 1,
      intervalMs: 60_000,
    });
    handle.stop();
    expect(logs.find((l) => l.includes('BF-4'))).toBeTruthy();
  });

  it('boot recovery sweep runs first with a higher row cap and finishes before the steady-state tick', async () => {
    /* Seed 18 candidates so the boot cap (default 20 in the wire,
     * 12 here) catches everything in one pass while the steady-state
     * limit (5) would have taken several intervals. */
    for (let i = 0; i < 18; i++) {
      insertBs(`bs-${i.toString().padStart(2, '0')}`, 1_000 + i);
    }
    const provider = stubProvider({});
    const logs: string[] = [];
    const handle = startDistillationBackfillScheduler({
      db,
      provider,
      log: (m) => logs.push(m),
      firstFireDelayMs: 60_000,
      intervalMs: 600_000,
      bootRecoveryLimit: 12,
      bootRecoveryDelayMs: 5,
    });
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
    }
    handle.stop();
    const bootLog = logs.find((l) => l.includes('boot-recovery'));
    expect(bootLog).toBeTruthy();
    expect(bootLog).toMatch(/processed=12/);
    expect(bootLog).toMatch(/hit_cap=true/);
    const populated = db
      .listBrainstorms({ limit: 100 })
      .filter((r) => r.last_summary && r.last_summary.length > 0);
    expect(populated.length).toBe(12);
    const upLine = logs.find((l) => l.includes('[distill-scheduler] up'));
    expect(upLine).toMatch(/boot_recovery_limit=12/);
  });

  it('headless mode distills via the claude -p engine with no provider configured', async () => {
    /* DEVNEURAL_DISTILL_HEADLESS=1 must bypass the provider guards
     * entirely: distill runs through the shared headless Opus engine
     * even when ollama is absent. Inject a spawn stub so no real
     * subprocess is launched. */
    process.env.DEVNEURAL_DISTILL_HEADLESS = '1';
    try {
      for (let i = 0; i < 3; i++) {
        insertBs(`bs-${i.toString().padStart(2, '0')}`, 1_000 + i);
      }
      const spawnHeadless = vi.fn(async () => 'topic\ndecision\nopen items');
      const logs: string[] = [];
      const handle = startDistillationBackfillScheduler({
        db,
        /* deliberately NO provider passed */
        log: (m) => logs.push(m),
        firstFireDelayMs: 10,
        intervalMs: 60_000,
        bootRecoveryLimit: 0,
        spawnHeadless,
      });
      await vi.advanceTimersByTimeAsync(15);
      for (let i = 0; i < 50; i++) {
        await Promise.resolve();
      }
      handle.stop();
      expect(logs.find((l) => l.includes('headless Opus engine'))).toBeTruthy();
      expect(spawnHeadless.mock.calls.length).toBe(3);
      const populated = db
        .listBrainstorms({ limit: 100 })
        .filter((r) => r.last_summary && r.last_summary.length > 0);
      expect(populated.length).toBe(3);
      const upLine = logs.find((l) => l.includes('[distill-scheduler] up'));
      expect(upLine).toMatch(/provider=headless-opus/);
    } finally {
      delete process.env.DEVNEURAL_DISTILL_HEADLESS;
    }
  });

  it('bootRecoveryLimit=0 disables the boot recovery sweep', async () => {
    insertBs('bs-only', 1_000);
    const provider = stubProvider({});
    const logs: string[] = [];
    const handle = startDistillationBackfillScheduler({
      db,
      provider,
      log: (m) => logs.push(m),
      firstFireDelayMs: 60_000,
      intervalMs: 600_000,
      bootRecoveryLimit: 0,
      bootRecoveryDelayMs: 5,
    });
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
    handle.stop();
    expect(logs.find((l) => l.includes('boot-recovery'))).toBeUndefined();
    const populated = db
      .listBrainstorms({ limit: 100 })
      .filter((r) => r.last_summary && r.last_summary.length > 0);
    expect(populated.length).toBe(0);
  });
});
