/**
 * Expectation-supervisor dispatcher wiring on the cross-session
 * inject transport (goal-audit fix wave, 2026-07-15).
 *
 * crossSessionInject is the fourth dispatch point (alongside
 * /lex/steer, /sessions/:id/prompt, /sessions/:id/inject in
 * routes.ts) that now records a lex_worker_expectation row on a
 * committed, successfully-delivered instruction from a declared Lex
 * anchor to its supervised worker. recordExpectation reaches through
 * the brainstorm-store's getStore() singleton rather than the `db`
 * handle crossSessionInject was called with, so these tests wire the
 * singleton explicitly via setStore and assert against it directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';

const TEST_SECRET = 'c'.repeat(64);
vi.mock('../src/dashboard/auth-secret.js', () => ({
  getAuthSecret: () => TEST_SECRET,
}));

import { crossSessionInject } from '../src/lex/cross-session-inject.js';
import { setStore as setBrainstormStore } from '../src/lex/brainstorm-store.js';
import type { IndexDb as IndexDbType } from '../src/store/index-db.js';
import type { PtyEntry } from '../src/dashboard/pty-host.js';

function tokenFor(subject: string): string {
  const minute = Math.floor(Date.now() / 60_000);
  return crypto
    .createHmac('sha256', TEST_SECRET)
    .update(`${subject}:${minute}`)
    .digest('hex');
}

/* LEX_ANCHOR supervises WORKER_ANCHOR (the worker's project_session
 * anchor id), whose live current_session_id is WORKER_SESSION -- the
 * same shape checkLexScope/supervisedAnchorIdFor expect, mirrored
 * from cross-session-inject-scope.test.ts's dbStub. */
const LEX_ANCHOR = 'bs-expect';
const WORKER_ANCHOR = 'proj-expect';
const WORKER_SESSION = 'cc-worker-expect-1111';

function dbStub(): IndexDbType {
  return {
    insertCrossSessionLog: vi.fn(),
    getLexSession: vi.fn((id: string) =>
      id === LEX_ANCHOR
        ? {
            id: LEX_ANCHOR,
            created_ms: 1,
            title: 'Expect Brainstorm',
            derived_title: null,
            status: 'live',
            current_pty_id: 'pty-lex-expect',
            cwd: 'C:/x/brainstorm-expect',
            supervises_project_anchor_id: WORKER_ANCHOR,
          }
        : null,
    ),
    getProjectSession: vi.fn((id: string) =>
      id === WORKER_ANCHOR
        ? {
            id: WORKER_ANCHOR,
            project_slug: 'expect-worker',
            cwd: 'C:/dev/Projects/expect-worker',
            title: null,
            status: 'live',
            current_session_id: WORKER_SESSION,
            current_bridge_id: 'b1',
            current_pty_id: 'pty-worker-expect',
            created_ms: 1,
            last_seen_ms: 2,
            previous_session_id: null,
          }
        : null,
    ),
    getBrainstorm: vi.fn(() => null),
  } as unknown as IndexDbType;
}

function livePty(sessionId: string): PtyEntry {
  return {
    ptyId: `pty-${sessionId}`,
    sessionId,
    cwd: '/tmp/x',
    command: 'claude',
    startedAt: Date.now(),
    lastActivity: Date.now(),
    exited: false,
  } as unknown as PtyEntry;
}

let insertWorkerExpectation: ReturnType<typeof vi.fn>;
let listOpenWorkerExpectations: ReturnType<typeof vi.fn>;
let closeWorkerExpectation: ReturnType<typeof vi.fn>;

beforeEach(() => {
  insertWorkerExpectation = vi.fn();
  /* Supersede policy (2026-07-15): recordExpectationWithPolicy reads
   * open rows off this same store singleton before writing. No test
   * in this file seeds a prior open expectation, so an empty array
   * keeps the policy's pre-filter on the cheap "no open rows, skip
   * the LLM" path and every assertion below still lands on a plain
   * insertWorkerExpectation call, same as before this wave.
   * closeWorkerExpectation is stubbed defensively; nothing here
   * exercises the 'contradicts' branch that would call it. */
  listOpenWorkerExpectations = vi.fn(() => []);
  closeWorkerExpectation = vi.fn();
  setBrainstormStore({
    db: {
      insertWorkerExpectation,
      listOpenWorkerExpectations,
      closeWorkerExpectation,
    } as unknown as IndexDbType,
  } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('crossSessionInject expectation dispatch', () => {
  it('records an expectation on a committed, accepted pty delivery to a known worker anchor', () => {
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: WORKER_SESSION,
        token: tokenFor(WORKER_SESSION),
        text: 'refactor the auth module\nsecond line of detail',
        commit: true,
        from_lex_anchor_id: LEX_ANCHOR,
        anchor_id: WORKER_ANCHOR,
      },
      dbStub(),
      { listPtys: () => [livePty(WORKER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('accepted');
    expect(insertWorkerExpectation).toHaveBeenCalledTimes(1);
    const row = insertWorkerExpectation.mock.calls[0]![0] as {
      brainstorm_id: string;
      anchor_id: string;
      expected_outcome: string;
    };
    expect(row.brainstorm_id).toBe(LEX_ANCHOR);
    expect(row.anchor_id).toBe(WORKER_ANCHOR);
    expect(row.expected_outcome).toBe('refactor the auth module');
  });

  it('records an expectation on a committed, accepted bridge delivery (no live pty)', () => {
    const queueSessionPrompt = vi.fn(() => ({
      ok: true as const,
      queued_at: new Date().toISOString(),
    }));
    const result = crossSessionInject(
      {
        target_session: WORKER_SESSION,
        token: tokenFor(WORKER_SESSION),
        text: 'ship the release',
        commit: true,
        from_lex_anchor_id: LEX_ANCHOR,
        anchor_id: WORKER_ANCHOR,
      },
      dbStub(),
      {
        listPtys: () => [],
        queueSessionPrompt,
        resolveDeliverableBridge: () => ({
          verdict: 'deliverable',
          selected: null,
          claimingRecords: [],
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.transport).toBe('bridge');
    expect(insertWorkerExpectation).toHaveBeenCalledTimes(1);
  });

  it('does not record when commit is false (suggestion)', () => {
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: WORKER_SESSION,
        token: tokenFor(WORKER_SESSION),
        text: 'consider this',
        commit: false,
        from_lex_anchor_id: LEX_ANCHOR,
        anchor_id: WORKER_ANCHOR,
      },
      dbStub(),
      { listPtys: () => [livePty(WORKER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(true);
    expect(insertWorkerExpectation).not.toHaveBeenCalled();
  });

  it('does not record when the pty delivery fails', () => {
    const ptyInject = vi.fn(() => ({ ok: false as const, error: 'write failed' }));
    const result = crossSessionInject(
      {
        target_session: WORKER_SESSION,
        token: tokenFor(WORKER_SESSION),
        text: 'do it',
        commit: true,
        from_lex_anchor_id: LEX_ANCHOR,
        anchor_id: WORKER_ANCHOR,
      },
      dbStub(),
      { listPtys: () => [livePty(WORKER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(false);
    expect(insertWorkerExpectation).not.toHaveBeenCalled();
  });

  it('does not record on a rejected_scope failure', () => {
    const OTHER_SESSION = 'cc-worker-other-9999';
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: OTHER_SESSION,
        token: tokenFor(OTHER_SESSION),
        text: 'wrong worker',
        commit: true,
        from_lex_anchor_id: LEX_ANCHOR,
        anchor_id: WORKER_ANCHOR,
      },
      dbStub(),
      { listPtys: () => [livePty(OTHER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(false);
    expect(result.decision).toBe('rejected_scope');
    expect(insertWorkerExpectation).not.toHaveBeenCalled();
  });

  it('does not record when anchor_id is not resolved on the request (e.g. no known worker anchor)', () => {
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: WORKER_SESSION,
        token: tokenFor(WORKER_SESSION),
        text: 'note to self',
        commit: true,
        from_lex_anchor_id: LEX_ANCHOR,
        /* anchor_id intentionally omitted */
      },
      dbStub(),
      { listPtys: () => [livePty(WORKER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(true);
    expect(insertWorkerExpectation).not.toHaveBeenCalled();
  });

  it('does not record when from_lex_anchor_id is absent (daemon-internal / cron caller)', () => {
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: WORKER_SESSION,
        token: tokenFor(WORKER_SESSION),
        text: 'cron nudge',
        commit: true,
        anchor_id: WORKER_ANCHOR,
      },
      dbStub(),
      { listPtys: () => [livePty(WORKER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(true);
    expect(insertWorkerExpectation).not.toHaveBeenCalled();
  });

  it('is best-effort: a store-singleton failure does not turn an already-successful inject into an error', () => {
    setBrainstormStore(undefined as never);
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: WORKER_SESSION,
        token: tokenFor(WORKER_SESSION),
        text: 'do it',
        commit: true,
        from_lex_anchor_id: LEX_ANCHOR,
        anchor_id: WORKER_ANCHOR,
      },
      dbStub(),
      { listPtys: () => [livePty(WORKER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('accepted');
  });
});
