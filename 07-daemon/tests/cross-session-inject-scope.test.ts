/**
 * Worker-scope enforcement on cross-session injects (bug: 2026-07-08
 * Lex controls all workers). When the caller declares which Lex
 * anchor it is (from_lex_anchor_id), the inject may only target:
 *   - the worker supervised by that anchor (current/previous session
 *     id or PTY of the supervised project_session row), or
 *   - the anchor's own brainstorm session/PTY (self-inject).
 * Anything else is rejected with decision 'rejected_scope' and an
 * audit row. Requests without from_lex_anchor_id keep the legacy
 * behavior (daemon-internal supervisors, cron, dashboard).
 */
import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';

const TEST_SECRET = 'a'.repeat(64);
vi.mock('../src/dashboard/auth-secret.js', () => ({
  getAuthSecret: () => TEST_SECRET,
}));

import {
  checkLexScope,
  crossSessionInject,
  supervisedAnchorIdFor,
} from '../src/lex/cross-session-inject.js';
import type { IndexDb as IndexDbType } from '../src/store/index-db.js';
import type { PtyEntry } from '../src/dashboard/pty-host.js';

function tokenFor(subject: string): string {
  const minute = Math.floor(Date.now() / 60_000);
  return crypto
    .createHmac('sha256', TEST_SECRET)
    .update(`${subject}:${minute}`)
    .digest('hex');
}

const LEX_ANCHOR = 'bs-mha';
const SUPERVISED_PROJECT = 'proj-mha';
const WORKER_SESSION = 'cc-worker-mha-1111';
const OTHER_SESSION = 'cc-worker-devneural-9999';
const OWN_BRAINSTORM_SESSION = 'cc-lex-own-3333';

function dbStub(overrides: Partial<Record<string, unknown>> = {}): IndexDbType {
  return {
    insertCrossSessionLog: vi.fn(),
    getLexSession: vi.fn((id: string) =>
      id === LEX_ANCHOR
        ? {
            id: LEX_ANCHOR,
            created_ms: 1,
            title: 'MHA Brainstorm',
            derived_title: null,
            status: 'live',
            current_pty_id: 'pty-lex',
            cwd: 'C:/x/brainstorm',
            supervises_project_anchor_id: SUPERVISED_PROJECT,
          }
        : null,
    ),
    getProjectSession: vi.fn((id: string) =>
      id === SUPERVISED_PROJECT
        ? {
            id: SUPERVISED_PROJECT,
            project_slug: 'Material-Handling-Academy',
            cwd: 'C:/dev/Projects/Material-Handling-Academy',
            title: null,
            status: 'live',
            current_session_id: WORKER_SESSION,
            current_bridge_id: 'b1',
            current_pty_id: 'pty-worker-mha-7777',
            created_ms: 1,
            last_seen_ms: 2,
            previous_session_id: 'cc-worker-mha-prev',
          }
        : null,
    ),
    getBrainstorm: vi.fn((id: string) =>
      id === LEX_ANCHOR
        ? {
            id: LEX_ANCHOR,
            claude_session_id: OWN_BRAINSTORM_SESSION,
            pty_id: 'pty-lex',
            status: 'active',
          }
        : null,
    ),
    ...overrides,
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

describe('crossSessionInject worker scope', () => {
  it('accepts an inject into the supervised worker', () => {
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: WORKER_SESSION,
        token: tokenFor(WORKER_SESSION),
        text: 'do the thing',
        commit: false,
        from_lex_anchor_id: LEX_ANCHOR,
      },
      dbStub(),
      { listPtys: () => [livePty(WORKER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('accepted');
    expect(ptyInject).toHaveBeenCalled();
  });

  it('accepts a self-inject into the anchor own brainstorm session', () => {
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: OWN_BRAINSTORM_SESSION,
        token: tokenFor(OWN_BRAINSTORM_SESSION),
        text: 'note to self',
        commit: false,
        from_lex_anchor_id: LEX_ANCHOR,
      },
      dbStub(),
      { listPtys: () => [livePty(OWN_BRAINSTORM_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('accepted');
  });

  it('rejects an inject into a worker outside the scope', () => {
    const db = dbStub();
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: OTHER_SESSION,
        token: tokenFor(OTHER_SESSION),
        text: 'wrong worker',
        commit: false,
        from_lex_anchor_id: LEX_ANCHOR,
      },
      db,
      { listPtys: () => [livePty(OTHER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(false);
    expect(result.decision).toBe('rejected_scope');
    expect(ptyInject).not.toHaveBeenCalled();
    /* audit row records the rejection */
    const log = (db.insertCrossSessionLog as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { decision?: string };
    expect(log?.decision).toBe('rejected_scope');
  });

  it('rejects any worker target when the anchor supervises nothing', () => {
    const db = dbStub({
      getLexSession: vi.fn(() => ({
        id: LEX_ANCHOR,
        created_ms: 1,
        title: 'MHA Brainstorm',
        derived_title: null,
        status: 'live',
        current_pty_id: 'pty-lex',
        cwd: 'C:/x/brainstorm',
        supervises_project_anchor_id: null,
      })),
    });
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: WORKER_SESSION,
        token: tokenFor(WORKER_SESSION),
        text: 'no worker bound',
        commit: false,
        from_lex_anchor_id: LEX_ANCHOR,
      },
      db,
      { listPtys: () => [livePty(WORKER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(false);
    expect(result.decision).toBe('rejected_scope');
  });

  it('rejects when the declared anchor does not exist', () => {
    const db = dbStub({ getLexSession: vi.fn(() => null) });
    const result = crossSessionInject(
      {
        target_session: WORKER_SESSION,
        token: tokenFor(WORKER_SESSION),
        text: 'ghost anchor',
        commit: false,
        from_lex_anchor_id: 'bs-ghost',
      },
      db,
      { listPtys: () => [livePty(WORKER_SESSION)], ptyInject: vi.fn(() => ({ ok: true as const })) },
    );
    expect(result.ok).toBe(false);
    expect(result.decision).toBe('rejected_scope');
  });

  it('accepts the previous worker session id (post-/clear flip)', () => {
    const result = checkLexScope(dbStub(), LEX_ANCHOR, 'cc-worker-mha-prev');
    expect(result.allowed).toBe(true);
  });

  it('accepts the supervised worker PTY id as a target', () => {
    const result = checkLexScope(dbStub(), LEX_ANCHOR, 'pty-worker-mha-7777');
    expect(result.allowed).toBe(true);
  });

  it('accepts an 8-char-or-longer uuid prefix of an allowed id', () => {
    /* Bridge queue targets resolve by uuid prefix; the scope check
     * mirrors that so a prefix-addressed inject to the own worker
     * is not spuriously rejected. */
    const result = checkLexScope(dbStub(), LEX_ANCHOR, WORKER_SESSION.slice(0, 8));
    expect(result.allowed).toBe(true);
  });

  it('rejects prefixes shorter than 8 chars even when they would match', () => {
    const result = checkLexScope(dbStub(), LEX_ANCHOR, WORKER_SESSION.slice(0, 7));
    expect(result.allowed).toBe(false);
  });

  it('rejects a prefix of a NON-allowed session id', () => {
    const result = checkLexScope(dbStub(), LEX_ANCHOR, OTHER_SESSION.slice(0, 12));
    expect(result.allowed).toBe(false);
  });

  it('falls back to the legacy brainstorm project_scope_id when lex_session has no supervises binding', () => {
    /* Enforcement must resolve scope the same way resolveLexScope
     * does, or a legacy-scoped anchor would see worker X in its
     * snapshot while every inject to X gets rejected. */
    const db = dbStub({
      getLexSession: vi.fn(() => ({
        id: LEX_ANCHOR,
        created_ms: 1,
        title: 'MHA Brainstorm',
        derived_title: null,
        status: 'live',
        current_pty_id: 'pty-lex',
        cwd: 'C:/x/brainstorm',
        supervises_project_anchor_id: null,
      })),
      getBrainstorm: vi.fn(() => ({
        id: LEX_ANCHOR,
        claude_session_id: OWN_BRAINSTORM_SESSION,
        pty_id: 'pty-lex',
        status: 'active',
        project_scope_id: SUPERVISED_PROJECT,
      })),
    });
    expect(supervisedAnchorIdFor(db, LEX_ANCHOR)).toBe(SUPERVISED_PROJECT);
    const result = checkLexScope(db, LEX_ANCHOR, WORKER_SESSION);
    expect(result.allowed).toBe(true);
    expect(result.supervised_slug).toBe('Material-Handling-Academy');
  });

  it('keeps legacy behavior when from_lex_anchor_id is absent', () => {
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: OTHER_SESSION,
        token: tokenFor(OTHER_SESSION),
        text: 'daemon-internal supervisor',
        commit: false,
      },
      dbStub(),
      { listPtys: () => [livePty(OTHER_SESSION)], ptyInject },
    );
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('accepted');
  });
});
