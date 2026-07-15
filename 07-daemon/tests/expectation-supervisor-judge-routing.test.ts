/**
 * expectation-supervisor.ts judge-session routing: both
 * classifySupersede (via recordExpectationWithPolicy) and
 * evaluateExpectation (via runExpectationTick) prefer the persistent
 * Max-plan judge session (askJudge) before falling back to the
 * existing callVoiceChat/ollama path. Mocks judge-session.js wholesale
 * so no real `claude` process is ever touched -- these tests only
 * prove the ROUTING contract; judge-session.ts's own internals are
 * covered by tests/judge-session.test.ts, and the pre-existing
 * ollama-only behavior is covered by tests/expectation-supervisor.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../src/lex/judge-session.js', () => ({
  askJudge: vi.fn(),
}));
vi.mock('../src/llm/voice-chat.js', () => ({
  callVoiceChat: vi.fn(),
}));
vi.mock('../src/dashboard/notifications.js', () => ({
  emitNotification: vi.fn(() => ({ id: 'notif-1' })),
}));

import { askJudge } from '../src/lex/judge-session.js';
import { callVoiceChat } from '../src/llm/voice-chat.js';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore as setBrainstormStore } from '../src/lex/brainstorm-store.js';
import { rootToSlug } from '../src/lex/cc-project-slug.js';
import {
  setSharedWorkerEventGate,
  WorkerEventGate,
} from '../src/dashboard/worker-event-router.js';
import {
  recordExpectation,
  recordExpectationWithPolicy,
  runExpectationTick,
} from '../src/lex/expectation-supervisor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_HOME = process.env.HOME;
afterAll(() => {
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

function seedWorkerJsonl(
  tmpRoot: string,
  cwd: string,
  sessionId: string,
  content: string,
): void {
  const home = path.join(tmpRoot, 'home');
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  const slug = rootToSlug(cwd);
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), content, 'utf-8');
}

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-expect-judge-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  setBrainstormStore({ db } as never);
  vi.mocked(askJudge).mockReset();
  vi.mocked(callVoiceChat).mockReset();
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

describe('classifySupersede (via recordExpectationWithPolicy): prefers the judge session', () => {
  const ANCHOR = 'anchor-judge-policy';
  const BRAINSTORM = 'bs-judge-policy';

  it('a "contradicts" judge verdict supersedes the prior row without ever calling callVoiceChat', async () => {
    const priorId = recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'refactor payments to use stripe',
    });
    vi.mocked(askJudge).mockResolvedValue({ verdict: 'contradicts' });

    const newId = await recordExpectationWithPolicy(
      {},
      {
        brainstormId: BRAINSTORM,
        anchorId: ANCHOR,
        expectedOutcome: 'stop refactoring payments',
      },
    );

    expect(callVoiceChat).not.toHaveBeenCalled();
    expect(askJudge).toHaveBeenCalledTimes(1);
    const call = vi.mocked(askJudge).mock.calls[0]![0];
    expect(call.kind).toBe('supersede');
    expect(call.timeoutMs).toBe(15_000);

    const open = db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM });
    expect(open.length).toBe(1);
    expect(open[0]!.id).toBe(newId);
    expect(open[0]!.id).not.toBe(priorId);
  });

  it('askJudge resolving null falls back to callVoiceChat (existing ollama path)', async () => {
    recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'write unit tests for checkout',
    });
    vi.mocked(askJudge).mockResolvedValue(null);
    vi.mocked(callVoiceChat).mockResolvedValue({
      text: JSON.stringify({ verdict: 'independent' }),
      modelId: 'test-model',
      inputTokens: 5,
      outputTokens: 5,
    });

    await recordExpectationWithPolicy(
      {},
      {
        brainstormId: BRAINSTORM,
        anchorId: ANCHOR,
        expectedOutcome: 'also update the README',
      },
    );

    expect(askJudge).toHaveBeenCalledTimes(1);
    expect(callVoiceChat).toHaveBeenCalledTimes(1);
    const open = db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM });
    expect(open.length).toBe(2); // 'independent' -> both stay open
  });

  it('askJudge returning a garbage shape (no recognised verdict) falls back to callVoiceChat', async () => {
    recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'ship the release',
    });
    vi.mocked(askJudge).mockResolvedValue({ nonsense: true });
    vi.mocked(callVoiceChat).mockResolvedValue({
      text: JSON.stringify({ verdict: 'contradicts' }),
      modelId: 'test-model',
      inputTokens: 5,
      outputTokens: 5,
    });

    await recordExpectationWithPolicy(
      {},
      {
        brainstormId: BRAINSTORM,
        anchorId: ANCHOR,
        expectedOutcome: 'cancel the release',
      },
    );

    expect(callVoiceChat).toHaveBeenCalledTimes(1);
  });

  it('no open rows on the anchor: neither askJudge nor callVoiceChat is ever called', async () => {
    await recordExpectationWithPolicy(
      {},
      {
        brainstormId: BRAINSTORM,
        anchorId: 'anchor-empty',
        expectedOutcome: 'do the thing',
      },
    );

    expect(askJudge).not.toHaveBeenCalled();
    expect(callVoiceChat).not.toHaveBeenCalled();
  });
});

describe('evaluateExpectation (via runExpectationTick): prefers the judge session', () => {
  const ANCHOR = 'anchor-judge-eval';
  const BRAINSTORM = 'bs-judge-eval';
  const SESSION_ID = '33333333-3333-3333-3333-333333333333';
  let cwd: string;

  beforeEach(() => {
    cwd = path.join(tmpDir, 'Projects', 'judge-eval-proj');
    seedWorkerJsonl(
      tmpDir,
      cwd,
      SESSION_ID,
      'plenty of worker activity here, well past the 80 character floor evaluateExpectation requires before it will even attempt a judge call',
    );
    db.insertProjectSession({
      id: ANCHOR,
      project_slug: 'judge-eval-proj',
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

  it('a valid judge-session alignment object short-circuits: callVoiceChat is never called', async () => {
    recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'write unit tests for the checkout flow',
    });
    vi.mocked(askJudge).mockResolvedValue({
      aligned: true,
      alignment_score: 0.9,
      drift_summary: '',
      suggested_correction: '',
    });

    const result = await runExpectationTick();

    expect(result.evaluated).toBe(1);
    expect(callVoiceChat).not.toHaveBeenCalled();
    expect(askJudge).toHaveBeenCalledTimes(1);
    const call = vi.mocked(askJudge).mock.calls[0]![0];
    expect(call.kind).toBe('alignment');

    const open = db.listOpenWorkerExpectations({ brainstormId: BRAINSTORM });
    expect(open.length).toBe(0); // high-confidence aligned -> closed
  });

  it('askJudge resolving null falls back to callVoiceChat and evaluates via the existing path', async () => {
    recordExpectation({
      brainstormId: BRAINSTORM,
      anchorId: ANCHOR,
      expectedOutcome: 'write unit tests for the checkout flow',
    });
    vi.mocked(askJudge).mockResolvedValue(null);
    vi.mocked(callVoiceChat).mockResolvedValue({
      text: JSON.stringify({
        aligned: false,
        alignment_score: 0.1,
        drift_summary: 'drifted off task',
        suggested_correction: 'refocus',
      }),
      modelId: 'test-model',
      inputTokens: 10,
      outputTokens: 10,
    });

    const result = await runExpectationTick();

    expect(askJudge).toHaveBeenCalledTimes(1);
    expect(callVoiceChat).toHaveBeenCalledTimes(1);
    expect(result.evaluated).toBe(1);
    expect(result.drift_fired).toBe(1);
  });
});
