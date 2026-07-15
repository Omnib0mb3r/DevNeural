/**
 * Expectation-supervisor bring-up (goal-audit fix wave, 2026-07-15).
 *
 * Finding (2026-07-15 goal audit): expectation-supervisor.ts ticked
 * every 90s forever but was dead by construction -- recordExpectation
 * (its only writer) had zero callers anywhere, so
 * lex_worker_expectation had zero rows, ever. This file pins:
 *
 *   - deriveExpectedOutcome: the deterministic text->label reduction
 *     the dispatcher call sites use.
 *   - runExpectationTick / startExpectationSupervisor's injected
 *     logger, replacing the raw console.log calls that were invisible
 *     to daemon.log's rotation and untestable via a spy (mirrors
 *     grooming-watch's installGroomingScheduler pattern, commit
 *     b656ead).
 *   - a seeded, evaluated-as-drifted expectation reaches
 *     emitNotification via fireForStall and stays open; a seeded,
 *     evaluated-as-aligned (high confidence) expectation closes and
 *     fires no notification.
 *
 * Dispatcher-side wiring (recordExpectation's actual callers) is
 * covered separately in cross-session-inject-expectation.test.ts and
 * tests/integration/expectation-dispatch-routes.int.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../src/llm/voice-chat.js', () => ({
  callVoiceChat: vi.fn(),
}));
vi.mock('../src/dashboard/notifications.js', () => ({
  emitNotification: vi.fn(() => ({ id: 'notif-1' })),
}));

import { callVoiceChat } from '../src/llm/voice-chat.js';
import { emitNotification } from '../src/dashboard/notifications.js';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore as setBrainstormStore } from '../src/lex/brainstorm-store.js';
import { rootToSlug } from '../src/lex/cc-project-slug.js';
import {
  setSharedWorkerEventGate,
  WorkerEventGate,
} from '../src/dashboard/worker-event-router.js';
import {
  deriveExpectedOutcome,
  recordExpectation,
  recordExpectationWithPolicy,
  runExpectationTick,
  startExpectationSupervisor,
} from '../src/lex/expectation-supervisor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

/* seedWorkerJsonl (below) repoints USERPROFILE/HOME at a per-test tmp
 * dir so resolveCcProjectDir's real directory scan finds the fake
 * transcript without mocking cc-project-slug.ts. Restore both at the
 * end of this file so the mutation cannot leak into any other test
 * file sharing this worker process. */
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_HOME = process.env.HOME;
afterAll(() => {
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

describe('deriveExpectedOutcome', () => {
  it('takes the first non-blank line', () => {
    expect(deriveExpectedOutcome('run the tests\nthen report back')).toBe(
      'run the tests',
    );
  });

  it('skips leading blank lines', () => {
    expect(deriveExpectedOutcome('\n\n  fix the bug  \nmore detail')).toBe(
      'fix the bug',
    );
  });

  it('collapses internal whitespace', () => {
    expect(deriveExpectedOutcome('do   the    thing\tnow')).toBe(
      'do the thing now',
    );
  });

  it('returns a placeholder for empty/whitespace-only input', () => {
    expect(deriveExpectedOutcome('')).toBe('(empty instruction)');
    expect(deriveExpectedOutcome('   \n  \n')).toBe('(empty instruction)');
  });

  it('truncates long lines with a trailing ellipsis, capped at 240 chars', () => {
    const long = 'x'.repeat(400);
    const result = deriveExpectedOutcome(long);
    expect(result.length).toBe(240);
    expect(result.endsWith('...')).toBe(true);
    expect(result.startsWith('x'.repeat(100))).toBe(true);
  });

  it('does not truncate a line at exactly the cap', () => {
    const exact = 'y'.repeat(240);
    expect(deriveExpectedOutcome(exact)).toBe(exact);
  });
});

describe('startExpectationSupervisor / runExpectationTick logging', () => {
  let tmpDir: string;
  let db: IndexDb;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-expect-sup-'));
    const dbFile = path.join(tmpDir, 'index.db');
    const seed = new IndexDb(dbFile);
    seed.close();
    await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
    db = new IndexDb(dbFile);
    setBrainstormStore({ db } as never);
    vi.mocked(callVoiceChat).mockReset();
    vi.mocked(emitNotification).mockClear();
    setSharedWorkerEventGate(new WorkerEventGate());
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setSharedWorkerEventGate(null);
  });

  it('logs a boot line with the resolved interval on start, and never touches console.log', () => {
    const log = vi.fn();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handle = startExpectationSupervisor({ intervalMs: 3_600_000, log });
    expect(log).toHaveBeenCalledWith(
      '[expectation-supervisor] up interval=3600000ms enabled=true',
    );
    expect(consoleSpy).not.toHaveBeenCalled();
    handle.stop();
    consoleSpy.mockRestore();
  });

  it('defaults to a no-op logger when none is supplied (does not throw)', () => {
    const handle = startExpectationSupervisor({ intervalMs: 3_600_000 });
    expect(() => handle.stop()).not.toThrow();
  });

  it('runExpectationTick logs a per-tick summary line with open/evaluated/drift_fired counts', async () => {
    const log = vi.fn();
    const result = await runExpectationTick({ log });
    expect(result).toEqual({ evaluated: 0, drift_fired: 0 });
    expect(log).toHaveBeenCalledWith(
      '[expectation-supervisor] tick open=0 evaluated=0 drift_fired=0',
    );
  });

  it('routes an evaluateExpectation LLM failure through the injected logger, not console.log', async () => {
    /* Seed one open expectation with a readable jsonl tail so
     * evaluateExpectation actually attempts the LLM call instead of
     * short-circuiting on "not enough activity yet". */
    const cwd = path.join(tmpDir, 'Projects', 'llm-fail-proj');
    const sessionId = '11111111-1111-1111-1111-111111111111';
    seedWorkerJsonl(tmpDir, cwd, sessionId, 'a'.repeat(200));
    db.insertProjectSession({
      id: 'anchor-llm-fail',
      project_slug: 'llm-fail-proj',
      cwd,
      title: null,
      status: 'live',
      current_session_id: sessionId,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
    recordExpectation({
      brainstormId: 'bs-llm-fail',
      anchorId: 'anchor-llm-fail',
      expectedOutcome: 'do the thing',
    });
    vi.mocked(callVoiceChat).mockRejectedValue(new Error('ollama unreachable'));

    const log = vi.fn();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runExpectationTick({ log });
    expect(result.evaluated).toBe(0);
    expect(
      log.mock.calls.some(([msg]) =>
        String(msg).startsWith(
          '[expectation] LLM call failed for id=',
        ),
      ),
    ).toBe(true);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

/* Writes ~/.claude/projects/<slug>/<sessionId>.jsonl with `content`
 * under a temp HOME so resolveCcProjectDir's real directory scan
 * finds it -- no mocking of cc-project-slug.ts needed. */
function seedWorkerJsonl(
  tmpRoot: string,
  cwd: string,
  sessionId: string,
  content: string,
): void {
  /* resolveCcProjectDir reads HOME/USERPROFILE lazily on every call,
   * so repointing it here is enough for the rest of the calling
   * test; the module-level afterAll above restores the real value
   * once this whole file is done. */
  const home = path.join(tmpRoot, 'home');
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  const slug = rootToSlug(cwd);
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), content, 'utf-8');
}

/* Raw row reader, including CLOSED rows -- listOpenWorkerExpectations
 * filters closed_at IS NULL by design, so the supersede-policy tests
 * below need a direct query to assert closed_reason='superseded'
 * landed on the prior row. Mirrors expectation-dispatch-routes.int
 * .test.ts's expectationRows() helper. */
function allExpectationRows(db: IndexDb): Array<{
  id: string;
  brainstorm_id: string;
  anchor_id: string;
  expected_outcome: string;
  closed_at: string | null;
  closed_reason: string | null;
}> {
  return (
    db as unknown as {
      db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } };
    }
  ).db
    .prepare('SELECT * FROM lex_worker_expectation ORDER BY created_at ASC')
    .all() as Array<{
    id: string;
    brainstorm_id: string;
    anchor_id: string;
    expected_outcome: string;
    closed_at: string | null;
    closed_reason: string | null;
  }>;
}

describe('runExpectationTick evaluation outcomes', () => {
  let tmpDir: string;
  let db: IndexDb;
  const ANCHOR = 'anchor-drift';
  const BRAINSTORM = 'bs-drift';
  const SESSION_ID = '22222222-2222-2222-2222-222222222222';
  let cwd: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-expect-eval-'));
    const dbFile = path.join(tmpDir, 'index.db');
    const seed = new IndexDb(dbFile);
    seed.close();
    await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
    db = new IndexDb(dbFile);
    setBrainstormStore({ db } as never);
    vi.mocked(callVoiceChat).mockReset();
    vi.mocked(emitNotification).mockClear();
    setSharedWorkerEventGate(new WorkerEventGate());

    cwd = path.join(tmpDir, 'Projects', 'drift-proj');
    seedWorkerJsonl(
      tmpDir,
      cwd,
      SESSION_ID,
      'the worker is refactoring the payments module instead of writing the requested tests, quite a lot of unrelated activity here to pad past the 80-char floor',
    );
    db.insertProjectSession({
      id: ANCHOR,
      project_slug: 'drift-proj',
      cwd,
      title: null,
      status: 'live',
      current_session_id: SESSION_ID,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setSharedWorkerEventGate(null);
  });

  it('a drifted evaluation stays open, persists the drift summary, and fires emitNotification via fireForStall', async () => {
    recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'write unit tests for the checkout flow',
    });
    vi.mocked(callVoiceChat).mockResolvedValue({
      text: JSON.stringify({
        aligned: false,
        alignment_score: 0.15,
        drift_summary: 'worker is refactoring payments, not writing tests',
        suggested_correction: 'redirect the worker back to the test task',
      }),
      modelId: 'test-model',
      inputTokens: 10,
      outputTokens: 10,
    });

    const log = vi.fn();
    const result = await runExpectationTick({ log });

    expect(result.evaluated).toBe(1);
    expect(result.drift_fired).toBe(1);
    expect(log).toHaveBeenCalledWith(
      '[expectation-supervisor] tick open=1 evaluated=1 drift_fired=1',
    );

    expect(emitNotification).toHaveBeenCalledTimes(1);
    const call = vi.mocked(emitNotification).mock.calls[0]![0] as {
      title: string;
      body: string;
      push_data?: { kind?: string; anchor_id?: string | null; brainstorm_id?: string | null };
    };
    expect(call.title).toBe('Worker stalled');
    expect(call.body).toContain('worker drift');
    expect(call.push_data?.kind).toBe('stall');
    expect(call.push_data?.anchor_id).toBe(ANCHOR);
    expect(call.push_data?.brainstorm_id).toBe(BRAINSTORM);

    const open = db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM });
    expect(open.length).toBe(1);
    expect(open[0]!.closed_at).toBeNull();
    expect(open[0]!.last_drift_summary).toBe(
      'worker is refactoring payments, not writing tests',
    );
    expect(open[0]!.last_alignment_score).toBeCloseTo(0.15);
  });

  it('a high-confidence aligned evaluation closes the expectation and fires no notification', async () => {
    recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'refactor the payments module',
    });
    vi.mocked(callVoiceChat).mockResolvedValue({
      text: JSON.stringify({
        aligned: true,
        alignment_score: 0.95,
        drift_summary: '',
        suggested_correction: '',
      }),
      modelId: 'test-model',
      inputTokens: 10,
      outputTokens: 10,
    });

    const result = await runExpectationTick();

    expect(result.evaluated).toBe(1);
    expect(result.drift_fired).toBe(0);
    expect(emitNotification).not.toHaveBeenCalled();

    const open = db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM });
    expect(open.length).toBe(0);
  });
});

/**
 * Operator's expectation-supersede policy (2026-07-15). Verbatim
 * intent: "if it's a contradictory instruction, supersede; or else a
 * new command should be heard and the replies combined if they
 * respond at the right time, just like a human would do."
 *
 * recordExpectationWithPolicy classifies a new dispatch against every
 * open row on the same anchor before recording it. These tests pin:
 *   - the cheap pre-filter (no open rows -> judge never called),
 *   - 'contradicts' -> prior row closes as 'superseded',
 *   - 'independent' -> prior row stays open, new row also recorded,
 *   - timeout / provider error -> fail-open to 'independent',
 *   - a superseded row is genuinely excluded from the next tick
 *     (closed_at is set, so listOpenWorkerExpectations drops it),
 *   - task-3 verification: runExpectationTick already evaluates every
 *     open row on an anchor independently against the same jsonl
 *     tail, so two INDEPENDENT open rows can both close in the same
 *     tick off one activity slice -- the "replies combined... just
 *     like a human would do" half of the policy needed no change to
 *     the tick loop itself.
 */
describe('recordExpectationWithPolicy (supersede policy)', () => {
  let tmpDir: string;
  let db: IndexDb;
  const ANCHOR = 'anchor-policy';
  const BRAINSTORM = 'bs-policy';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-expect-policy-'));
    const dbFile = path.join(tmpDir, 'index.db');
    const seed = new IndexDb(dbFile);
    seed.close();
    await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
    db = new IndexDb(dbFile);
    setBrainstormStore({ db } as never);
    vi.mocked(callVoiceChat).mockReset();
    vi.mocked(emitNotification).mockClear();
    setSharedWorkerEventGate(new WorkerEventGate());
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setSharedWorkerEventGate(null);
  });

  it('no open rows on the anchor: records the new row and never calls the judge', async () => {
    const id = await recordExpectationWithPolicy(
      {},
      {
        brainstormId: BRAINSTORM,
        anchorId: ANCHOR,
        expectedOutcome: 'do the thing',
      },
    );

    expect(callVoiceChat).not.toHaveBeenCalled();
    const open = db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM });
    expect(open.length).toBe(1);
    expect(open[0]!.id).toBe(id);
    expect(open[0]!.expected_outcome).toBe('do the thing');
  });

  it("'contradicts' verdict closes the prior open row as superseded and still records the new one", async () => {
    const priorId = recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'refactor payments to use stripe',
    });
    vi.mocked(callVoiceChat).mockResolvedValue({
      text: JSON.stringify({ verdict: 'contradicts' }),
      modelId: 'test-model',
      inputTokens: 5,
      outputTokens: 5,
    });

    const newId = await recordExpectationWithPolicy(
      {},
      {
        brainstormId: BRAINSTORM,
        anchorId: ANCHOR,
        expectedOutcome: 'stop refactoring payments, revert to the old gateway',
      },
    );

    const rows = allExpectationRows(db);
    expect(rows.length).toBe(2);
    const prior = rows.find((r) => r.id === priorId)!;
    expect(prior.closed_reason).toBe('superseded');
    expect(prior.closed_at).not.toBeNull();
    const fresh = rows.find((r) => r.id === newId)!;
    expect(fresh.closed_at).toBeNull();
    expect(fresh.expected_outcome).toBe(
      'stop refactoring payments, revert to the old gateway',
    );

    const open = db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM });
    expect(open.length).toBe(1);
    expect(open[0]!.id).toBe(newId);
  });

  it("'independent' verdict leaves the prior row open and records the new one alongside it", async () => {
    const priorId = recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'write unit tests for checkout',
    });
    vi.mocked(callVoiceChat).mockResolvedValue({
      text: JSON.stringify({ verdict: 'independent' }),
      modelId: 'test-model',
      inputTokens: 5,
      outputTokens: 5,
    });

    const newId = await recordExpectationWithPolicy(
      {},
      {
        brainstormId: BRAINSTORM,
        anchorId: ANCHOR,
        expectedOutcome: 'also update the README',
      },
    );

    const open = db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM });
    expect(open.length).toBe(2);
    expect(open.map((r) => r.id).sort()).toEqual([priorId, newId].sort());
  });

  it('a hard timeout fails open to independent: keeps both rows open within the bound', async () => {
    recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'ship the release',
    });
    vi.mocked(callVoiceChat).mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves: forces the internal timeout branch to win */
        }),
    );

    const start = Date.now();
    await recordExpectationWithPolicy(
      { timeoutMs: 40 },
      {
        brainstormId: BRAINSTORM,
        anchorId: ANCHOR,
        expectedOutcome: 'also ping the release channel',
      },
    );
    const elapsed = Date.now() - start;

    // Generous upper bound: proves the hard timeout actually gates the
    // call rather than falling through to the mock's real (infinite) latency.
    expect(elapsed).toBeLessThan(2000);
    const open = db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM });
    expect(open.length).toBe(2);
  }, 10000);

  it('a provider error fails open to independent: keeps both rows open', async () => {
    recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'ship the release',
    });
    vi.mocked(callVoiceChat).mockRejectedValue(new Error('ollama unreachable'));

    await recordExpectationWithPolicy(
      {},
      {
        brainstormId: BRAINSTORM,
        anchorId: ANCHOR,
        expectedOutcome: 'also ping the release channel',
      },
    );

    const open = db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM });
    expect(open.length).toBe(2);
  });

  it('a superseded row is excluded from the next tick, even though a second open row on the same anchor is still evaluated', async () => {
    const cwd = path.join(tmpDir, 'Projects', 'policy-proj');
    const sessionId = '55555555-5555-5555-5555-555555555555';
    seedWorkerJsonl(
      tmpDir,
      cwd,
      sessionId,
      'the worker shipped the release and pinged the channel as requested, quite a lot of unrelated padding text here to clear the 80-char floor',
    );
    db.insertProjectSession({
      id: ANCHOR,
      project_slug: 'policy-proj',
      cwd,
      title: null,
      status: 'live',
      current_session_id: sessionId,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });

    const priorId = recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'refactor payments to use stripe',
    });
    vi.mocked(callVoiceChat).mockResolvedValueOnce({
      text: JSON.stringify({ verdict: 'contradicts' }),
      modelId: 'test-model',
      inputTokens: 5,
      outputTokens: 5,
    });
    const newId = await recordExpectationWithPolicy(
      {},
      {
        brainstormId: BRAINSTORM,
        anchorId: ANCHOR,
        expectedOutcome: 'ship the release and ping the channel',
      },
    );

    vi.mocked(callVoiceChat).mockReset();
    vi.mocked(callVoiceChat).mockResolvedValue({
      text: JSON.stringify({
        aligned: true,
        alignment_score: 0.9,
        drift_summary: '',
        suggested_correction: '',
      }),
      modelId: 'test-model',
      inputTokens: 5,
      outputTokens: 5,
    });

    const result = await runExpectationTick();

    // Only the surviving row reaches the judge; the superseded row's
    // closed_at excludes it from listOpenWorkerExpectations entirely.
    expect(result.evaluated).toBe(1);
    expect(callVoiceChat).toHaveBeenCalledTimes(1);
    const rows = allExpectationRows(db);
    expect(rows.find((r) => r.id === priorId)!.closed_reason).toBe(
      'superseded',
    );
    expect(rows.find((r) => r.id === newId)!.closed_reason).toBe('completed');
  });

  it('task-3 verification: one activity slice can close two independent open rows on the same anchor in a single tick', async () => {
    const cwd = path.join(tmpDir, 'Projects', 'combine-proj');
    const sessionId = '66666666-6666-6666-6666-666666666666';
    seedWorkerJsonl(
      tmpDir,
      cwd,
      sessionId,
      'the worker wrote the checkout unit tests and also updated the README in the same commit, quite a lot of unrelated padding text to clear the floor',
    );
    db.insertProjectSession({
      id: ANCHOR,
      project_slug: 'combine-proj',
      cwd,
      title: null,
      status: 'live',
      current_session_id: sessionId,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });

    const firstId = recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'write unit tests for checkout',
    });
    vi.mocked(callVoiceChat).mockResolvedValue({
      text: JSON.stringify({ verdict: 'independent' }),
      modelId: 'test-model',
      inputTokens: 5,
      outputTokens: 5,
    });
    const secondId = await recordExpectationWithPolicy(
      {},
      {
        brainstormId: BRAINSTORM,
        anchorId: ANCHOR,
        expectedOutcome: 'also update the README',
      },
    );
    expect(db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM }).length).toBe(
      2,
    );

    // Same activity slice judged aligned for both open rows -- this is
    // the "replies combined... just like a human would do" behavior.
    vi.mocked(callVoiceChat).mockReset();
    vi.mocked(callVoiceChat).mockResolvedValue({
      text: JSON.stringify({
        aligned: true,
        alignment_score: 0.95,
        drift_summary: '',
        suggested_correction: '',
      }),
      modelId: 'test-model',
      inputTokens: 5,
      outputTokens: 5,
    });

    const result = await runExpectationTick();

    expect(result.evaluated).toBe(2);
    expect(callVoiceChat).toHaveBeenCalledTimes(2);
    expect(db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM }).length).toBe(
      0,
    );
    const rows = allExpectationRows(db);
    expect(rows.find((r) => r.id === firstId)!.closed_reason).toBe(
      'completed',
    );
    expect(rows.find((r) => r.id === secondId)!.closed_reason).toBe(
      'completed',
    );
  });
});
