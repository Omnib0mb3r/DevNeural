/**
 * Control-transport fix (2026-07-14) — integration coverage for the
 * four operator-path routes that previously lacked Fix 15's
 * anchor-resolved dispatch (resolveAnchorDispatch) and the rejected_
 * scope audit trail: /lex/steer, /sessions/:id/prompt,
 * /sessions/:id/suggest, /sessions/:id/inject.
 *
 * These tests deliberately avoid asserting on a SUCCESSFUL bridge
 * delivery: DATA_ROOT (07-daemon/src/paths.ts) is a module-level
 * constant frozen at first import from process.env.DEVNEURAL_DATA_ROOT,
 * so a real bridge-presence directory cannot be pointed at a per-test
 * tmp dir the way the route's real resolveDeliverableBridgeForSession
 * call resolves it (no override param on the route). Every target
 * uuid used here is a fresh randomUUID(), which no real bridge
 * presence file on this host can ever claim, so the deliverability
 * gate deterministically reports 'not_claimed' regardless of ambient
 * machine state — that gives a reproducible, non-flaky assertion
 * surface. What's under test is the NEW behavior: anchor-resolved
 * redirect, the deliverability gate replacing blind-queue, and the
 * rejected_scope audit row + log line, all verified against the real
 * SQLite db this test owns.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-ctrl-transport-'));
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
  setBrainstormStore({ db });
  app = Fastify({ logger: false });
  await registerDashboardRoutes(app, { db } as never, () => undefined);
});

afterEach(async () => {
  await app.close();
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* Raw query helper: listCrossSessionLogs's TS decision filter union is
 * stale (missing several decisions insertCrossSessionLog itself
 * accepts), so tests read the table directly the same way
 * panic-routes.test.ts reaches into IndexDb's private handle. */
function logsFor(decision: string): Array<{
  target_session: string;
  caller_label: string | null;
  decision: string;
  reject_reason: string | null;
}> {
  return (
    db as unknown as {
      db: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } };
    }
  ).db
    .prepare('SELECT * FROM cross_session_injection_log WHERE decision = ?')
    .all(decision) as Array<{
    target_session: string;
    caller_label: string | null;
    decision: string;
    reject_reason: string | null;
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

describe('/lex/steer anchor-resolved dispatch (Fix 15 parity)', () => {
  it('redirects a stale uuid to the anchors live session and writes a redirected audit row', async () => {
    const LIVE = randomUUID();
    const STALE = randomUUID();
    seedLiveAnchor({
      id: 'anchor-steer-redirect',
      current_session_id: LIVE,
      previous_session_id: STALE,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/lex/steer/${STALE}`,
      payload: { text: 'status?' },
    });
    /* No daemon PTY and no real bridge claims a fresh random uuid on
     * this host, so delivery itself cannot succeed in-process; the
     * behavior under test is that the ROUTE resolved and redirected
     * the dispatch target before attempting delivery at all. */
    expect(res.statusCode).toBe(404);
    const body = res.json() as { ok: boolean; decision?: string };
    expect(body.ok).toBe(false);
    expect(body.decision).toBe('no_deliverable_bridge');

    const rows = logsFor('redirected');
    expect(rows.length).toBe(1);
    expect(rows[0]!.target_session).toBe(STALE);
    const reason = JSON.parse(rows[0]!.reject_reason ?? '{}') as {
      old_session: string;
      new_session: string;
      anchor_id: string;
    };
    expect(reason.old_session).toBe(STALE);
    expect(reason.new_session).toBe(LIVE);
    expect(reason.anchor_id).toBe('anchor-steer-redirect');
  });

  it('returns 422 bound-anchor-dormant and parks a dispatched_dead_session row when the owning anchor is dormant', async () => {
    const STALE = randomUUID();
    db.insertProjectSession({
      id: 'anchor-steer-dormant',
      project_slug: 'anchor-steer-dormant',
      cwd: 'C:/p/anchor-steer-dormant',
      title: 'dormant',
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
    db.updateProjectSession('anchor-steer-dormant', {
      previous_session_id: STALE,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/lex/steer/${STALE}`,
      payload: { text: 'status?' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { ok: boolean; reason?: string; anchor_id?: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('bound-anchor-dormant');
    expect(body.anchor_id).toBe('anchor-steer-dormant');

    const rows = logsFor('dispatched_dead_session');
    expect(rows.length).toBe(1);
    expect(rows[0]!.target_session).toBe(STALE);
  });

  it('rejects an out-of-scope steer target and writes a rejected_scope audit row (previously silent)', async () => {
    const WORKER_A = randomUUID();
    const WORKER_B = randomUUID();
    seedLiveAnchor({ id: 'proj-a-steer', current_session_id: WORKER_A });
    seedLiveAnchor({ id: 'proj-b-steer', current_session_id: WORKER_B });
    db.insertLexSession({
      id: 'lex-a-steer',
      created_ms: 1,
      title: 'lex-a',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/x/brainstorm-a',
      supervises_project_anchor_id: 'proj-a-steer',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/lex/steer/${WORKER_B}`,
      payload: { text: 'do the thing', from_anchor_id: 'lex-a-steer' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { ok: boolean; decision?: string };
    expect(body.ok).toBe(false);
    expect(body.decision).toBe('rejected_scope');

    /* This is the regression the fix closes: before, this branch had
     * no log() and no audit row at all. It also exercises migration
     * 047 (the decision CHECK widened to accept 'rejected_scope') —
     * without that migration the insert silently fails against the
     * real CHECK constraint and this row simply would not exist. */
    const rows = logsFor('rejected_scope');
    expect(rows.length).toBe(1);
    expect(rows[0]!.target_session).toBe(WORKER_B);
    expect(rows[0]!.caller_label).toBe('lex-a-steer');
  });
});

describe('/sessions/:id/prompt deliverability gate (Bug 3e parity)', () => {
  it('refuses to blind-queue when no bridge claims the target and returns no_deliverable_bridge', async () => {
    const target = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${target}/prompt`,
      payload: { text: 'hello' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as {
      ok: boolean;
      decision?: string;
      deliverability_verdict?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.decision).toBe('no_deliverable_bridge');
    expect(body.deliverability_verdict).toBe('not_claimed');
  });

  it('rejects an out-of-scope prompt target and writes a rejected_scope audit row', async () => {
    const WORKER_A = randomUUID();
    const WORKER_B = randomUUID();
    seedLiveAnchor({ id: 'proj-a-prompt', current_session_id: WORKER_A });
    seedLiveAnchor({ id: 'proj-b-prompt', current_session_id: WORKER_B });
    db.insertLexSession({
      id: 'lex-a-prompt',
      created_ms: 1,
      title: 'lex-a',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/x/brainstorm-a2',
      supervises_project_anchor_id: 'proj-a-prompt',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${WORKER_B}/prompt`,
      payload: { text: 'wrong worker', from_anchor_id: 'lex-a-prompt' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { ok: boolean; decision?: string };
    expect(body.decision).toBe('rejected_scope');
    const rows = logsFor('rejected_scope');
    expect(rows.length).toBe(1);
    expect(rows[0]!.target_session).toBe(WORKER_B);
  });
});

describe('/sessions/:id/suggest deliverability gate (Bug 3e parity)', () => {
  it('refuses to blind-queue when no bridge claims the target', async () => {
    const target = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${target}/suggest`,
      payload: { text: 'consider this' },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { ok: boolean; decision?: string };
    expect(body.ok).toBe(false);
    expect(body.decision).toBe('no_deliverable_bridge');
  });
});

describe('/sessions/:id/inject anchor-resolved dispatch + scope audit', () => {
  it('redirects a stale uuid before attempting delivery', async () => {
    const LIVE = randomUUID();
    const STALE = randomUUID();
    seedLiveAnchor({
      id: 'anchor-inject-redirect',
      current_session_id: LIVE,
      previous_session_id: STALE,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${STALE}/inject`,
      payload: { text: 'status?' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { ok: boolean; decision?: string };
    expect(body.decision).toBe('no_deliverable_bridge');
    const rows = logsFor('redirected');
    expect(rows.length).toBe(1);
    const reason = JSON.parse(rows[0]!.reject_reason ?? '{}') as {
      old_session: string;
      new_session: string;
    };
    expect(reason.old_session).toBe(STALE);
    expect(reason.new_session).toBe(LIVE);
  });

  it('rejects an out-of-scope inject target and writes a rejected_scope audit row', async () => {
    const WORKER_A = randomUUID();
    const WORKER_B = randomUUID();
    seedLiveAnchor({ id: 'proj-a-inject', current_session_id: WORKER_A });
    seedLiveAnchor({ id: 'proj-b-inject', current_session_id: WORKER_B });
    db.insertLexSession({
      id: 'lex-a-inject',
      created_ms: 1,
      title: 'lex-a',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/x/brainstorm-a3',
      supervises_project_anchor_id: 'proj-a-inject',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${WORKER_B}/inject`,
      payload: { text: 'wrong worker', from_anchor_id: 'lex-a-inject' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { ok: boolean; decision?: string };
    expect(body.decision).toBe('rejected_scope');
    const rows = logsFor('rejected_scope');
    expect(rows.length).toBe(1);
    expect(rows[0]!.target_session).toBe(WORKER_B);
  });
});
