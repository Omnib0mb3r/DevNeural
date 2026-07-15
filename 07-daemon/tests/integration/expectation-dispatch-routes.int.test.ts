/**
 * Expectation-supervisor dispatcher wiring on the operator-path
 * routes (goal-audit fix wave, 2026-07-15). /lex/steer,
 * /sessions/:id/prompt, and /sessions/:id/inject are three of the
 * four dispatch points that now call recordExpectation on a
 * committed, successfully-delivered instruction from a declared Lex
 * anchor to its supervised worker (the fourth, crossSessionInject,
 * has its own coverage in cross-session-inject-expectation.test.ts).
 * Before this wave recordExpectation had zero callers anywhere and
 * lex_worker_expectation had zero rows, ever -- see the 2026-07-15
 * goal audit.
 *
 * Delivery itself is mocked at the transport boundary (ptyInject /
 * queueSessionPrompt / resolveDeliverableBridgeForSession) rather
 * than exercised for real -- see control-transport-routes.int.test.ts's
 * header comment for why a real bridge/PTY delivery cannot be forced
 * from this harness (DATA_ROOT is a module-level constant frozen at
 * first import, so no per-test bridge-presence directory can be
 * pointed at). What's under test here is routes.ts's OWN new
 * behavior: does a successful delivery record exactly one
 * lex_worker_expectation row with the right brainstorm_id / anchor_id
 * / expected_outcome, and does it correctly skip suggestions,
 * failures, and callers with no declared Lex anchor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

vi.mock('../../src/dashboard/pty-host.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/dashboard/pty-host.js')>();
  return {
    ...actual,
    ptyInject: vi.fn(() => ({ ok: true as const })),
  };
});

vi.mock('../../src/dashboard/bridge-presence.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../src/dashboard/bridge-presence.js')
    >();
  return {
    ...actual,
    resolveDeliverableBridgeForSession: vi.fn(() => ({
      verdict: 'deliverable' as const,
      selected: null,
      claimingRecords: [],
    })),
  };
});

vi.mock('../../src/dashboard/sessions.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/dashboard/sessions.js')>();
  return {
    ...actual,
    queueSessionPrompt: vi.fn(() => ({
      ok: true as const,
      queued_at: new Date().toISOString(),
    })),
  };
});

import Fastify from 'fastify';
import { IndexDb } from '../../src/store/index-db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { registerDashboardRoutes } from '../../src/dashboard/routes.js';
import { setStore as setBrainstormStore } from '../../src/lex/brainstorm-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-expect-routes-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  setBrainstormStore({ db } as never);
  app = Fastify({ logger: false });
  await registerDashboardRoutes(app, { db } as never, () => undefined);
});

afterEach(async () => {
  await app.close();
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function expectationRows(): Array<{
  brainstorm_id: string;
  anchor_id: string;
  expected_outcome: string;
  closed_at: string | null;
}> {
  return (
    db as unknown as {
      db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } };
    }
  ).db
    .prepare('SELECT * FROM lex_worker_expectation')
    .all() as Array<{
    brainstorm_id: string;
    anchor_id: string;
    expected_outcome: string;
    closed_at: string | null;
  }>;
}

function seedLiveAnchor(opts: {
  id: string;
  current_session_id: string | null;
  previous_session_id?: string | null;
  current_pty_id?: string | null;
}): void {
  db.insertProjectSession({
    id: opts.id,
    project_slug: opts.id,
    cwd: `C:/p/${opts.id}`,
    title: opts.id,
    status: 'live',
    current_session_id: opts.current_session_id,
    current_bridge_id: `b-${opts.id}`,
    current_pty_id: opts.current_pty_id ?? null,
    created_ms: 1,
    last_seen_ms: 1,
  });
  if (opts.previous_session_id) {
    db.updateProjectSession(opts.id, {
      previous_session_id: opts.previous_session_id,
    });
  }
}

function seedSupervisingLex(id: string, anchorId: string): void {
  db.insertLexSession({
    id,
    created_ms: 1,
    title: id,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: `C:/x/${id}`,
    supervises_project_anchor_id: anchorId,
  });
}

describe('/lex/steer records an expectation on delivered dispatch', () => {
  it('records one lex_worker_expectation row on a committed, successful steer', async () => {
    const WORKER = randomUUID();
    seedLiveAnchor({ id: 'anchor-steer-expect', current_session_id: WORKER });
    seedSupervisingLex('lex-steer-expect', 'anchor-steer-expect');

    const res = await app.inject({
      method: 'POST',
      url: `/lex/steer/${WORKER}`,
      payload: {
        text: 'run the migration\nand report back',
        from_anchor_id: 'lex-steer-expect',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    const rows = expectationRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.brainstorm_id).toBe('lex-steer-expect');
    expect(rows[0]!.anchor_id).toBe('anchor-steer-expect');
    expect(rows[0]!.expected_outcome).toBe('run the migration');
    expect(rows[0]!.closed_at).toBeNull();
  });

  it('does not record when commit is false (steer suggestion)', async () => {
    const WORKER = randomUUID();
    seedLiveAnchor({ id: 'anchor-steer-suggest', current_session_id: WORKER });
    seedSupervisingLex('lex-steer-suggest', 'anchor-steer-suggest');

    const res = await app.inject({
      method: 'POST',
      url: `/lex/steer/${WORKER}`,
      payload: {
        text: 'consider trying this',
        from_anchor_id: 'lex-steer-suggest',
        commit: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(expectationRows().length).toBe(0);
  });

  it('does not record when no from_anchor_id is declared (daemon-internal caller)', async () => {
    const WORKER = randomUUID();
    seedLiveAnchor({ id: 'anchor-steer-noanchor', current_session_id: WORKER });

    const res = await app.inject({
      method: 'POST',
      url: `/lex/steer/${WORKER}`,
      payload: { text: 'do it' },
    });
    expect(res.statusCode).toBe(200);
    expect(expectationRows().length).toBe(0);
  });

  it('does not record on a rejected_scope failure', async () => {
    const WORKER_A = randomUUID();
    const WORKER_B = randomUUID();
    seedLiveAnchor({ id: 'proj-a-steer-expect', current_session_id: WORKER_A });
    seedLiveAnchor({ id: 'proj-b-steer-expect', current_session_id: WORKER_B });
    seedSupervisingLex('lex-a-steer-expect', 'proj-a-steer-expect');

    const res = await app.inject({
      method: 'POST',
      url: `/lex/steer/${WORKER_B}`,
      payload: { text: 'wrong worker', from_anchor_id: 'lex-a-steer-expect' },
    });
    expect(res.statusCode).toBe(403);
    expect(expectationRows().length).toBe(0);
  });
});

describe('/sessions/:id/inject records an expectation on delivered dispatch', () => {
  it('records one row on a committed, successful inject (pty transport)', async () => {
    const WORKER = randomUUID();
    seedLiveAnchor({ id: 'anchor-inject-expect', current_session_id: WORKER });
    seedSupervisingLex('lex-inject-expect', 'anchor-inject-expect');

    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${WORKER}/inject`,
      payload: { text: 'ship it', from_anchor_id: 'lex-inject-expect' },
    });
    expect(res.statusCode).toBe(200);
    const rows = expectationRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.brainstorm_id).toBe('lex-inject-expect');
    expect(rows[0]!.anchor_id).toBe('anchor-inject-expect');
    expect(rows[0]!.expected_outcome).toBe('ship it');
  });

  it('does not record when commit:false', async () => {
    const WORKER = randomUUID();
    seedLiveAnchor({ id: 'anchor-inject-suggest', current_session_id: WORKER });
    seedSupervisingLex('lex-inject-suggest', 'anchor-inject-suggest');

    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${WORKER}/inject`,
      payload: {
        text: 'maybe try this',
        from_anchor_id: 'lex-inject-suggest',
        commit: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(expectationRows().length).toBe(0);
  });
});

describe('/sessions/:id/prompt records an expectation on delivered dispatch', () => {
  it('records one row on a successful bridge-delivered prompt (always commits)', async () => {
    const WORKER = randomUUID();
    seedLiveAnchor({ id: 'anchor-prompt-expect', current_session_id: WORKER });
    seedSupervisingLex('lex-prompt-expect', 'anchor-prompt-expect');

    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${WORKER}/prompt`,
      payload: { text: 'status update please', from_anchor_id: 'lex-prompt-expect' },
    });
    expect(res.statusCode).toBe(200);
    const rows = expectationRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.brainstorm_id).toBe('lex-prompt-expect');
    expect(rows[0]!.anchor_id).toBe('anchor-prompt-expect');
    expect(rows[0]!.expected_outcome).toBe('status update please');
  });

  it('does not record when no from_anchor_id is declared', async () => {
    const WORKER = randomUUID();
    seedLiveAnchor({ id: 'anchor-prompt-noanchor', current_session_id: WORKER });

    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${WORKER}/prompt`,
      payload: { text: 'status update please' },
    });
    expect(res.statusCode).toBe(200);
    expect(expectationRows().length).toBe(0);
  });
});
