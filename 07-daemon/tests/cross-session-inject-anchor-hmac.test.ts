/**
 * Fix 15 C2 — anchor_id-signed HMAC alternate verification.
 *
 * Anchor ids are stable across /clear-driven session uuid flips, so
 * supervisory callers (smart-compact, Lex compaction, second agents)
 * should sign their HMAC against the anchor id rather than the
 * session uuid. This test verifies that a token derived against the
 * anchor id is accepted by crossSessionInject when signed_anchor_id
 * is plumbed through, and that an anchor-signed token does NOT
 * verify against an unrelated subject.
 */
import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';

const TEST_SECRET = 'a'.repeat(64);
vi.mock('../src/dashboard/auth-secret.js', () => ({
  getAuthSecret: () => TEST_SECRET,
}));

import { crossSessionInject } from '../src/lex/cross-session-inject.js';
import type { IndexDb as IndexDbType } from '../src/store/index-db.js';
import type { PtyEntry } from '../src/dashboard/pty-host.js';

function tokenFor(subject: string): string {
  const minute = Math.floor(Date.now() / 60_000);
  return crypto
    .createHmac('sha256', TEST_SECRET)
    .update(`${subject}:${minute}`)
    .digest('hex');
}

function dbStub(): IndexDbType {
  return {
    insertCrossSessionLog: vi.fn(),
  } as unknown as IndexDbType;
}

describe('crossSessionInject anchor_id-signed HMAC alternate (Fix 15 C2)', () => {
  const sessionUuid = 'sess-7777';
  const anchorId = 'anchor-zeta';
  const ptyId = sessionUuid;

  const livePty: PtyEntry = {
    ptyId,
    sessionId: sessionUuid,
    cwd: '/tmp/x',
    command: 'claude',
    startedAt: Date.now(),
    lastActivity: Date.now(),
    exited: false,
  } as unknown as PtyEntry;

  it('accepts a token signed against the anchor id when signed_anchor_id is supplied', () => {
    let bytes = '';
    const ptyInject = vi.fn((_id: string, text: string) => {
      bytes += text;
      return { ok: true as const };
    });
    const result = crossSessionInject(
      {
        target_session: sessionUuid,
        token: tokenFor(anchorId),
        text: 'hello',
        signed_anchor_id: anchorId,
        anchor_id: anchorId,
        commit: false,
      },
      dbStub(),
      {
        listPtys: () => [livePty],
        ptyInject,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('accepted');
    expect(bytes).toContain('hello');
  });

  it('still accepts a legacy session-signed token (back-compat)', () => {
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: sessionUuid,
        token: tokenFor(sessionUuid),
        text: 'hi',
        commit: false,
      },
      dbStub(),
      {
        listPtys: () => [livePty],
        ptyInject,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('accepted');
  });

  it('rejects when the anchor-signed token is supplied without signed_anchor_id', () => {
    /* Without telling the daemon the signing subject, the legacy
     * verification path tries only the target_session — which does
     * NOT match the anchor signature. Confirms anchor-mode signing
     * is gated by the explicit subject and not a silent fallback. */
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: sessionUuid,
        token: tokenFor(anchorId),
        text: 'hi',
        commit: false,
      },
      dbStub(),
      {
        listPtys: () => [livePty],
        ptyInject,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.decision).toBe('rejected_auth');
    expect(ptyInject).not.toHaveBeenCalled();
  });

  it('rejects a token signed against an unrelated subject even with signed_anchor_id set', () => {
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const result = crossSessionInject(
      {
        target_session: sessionUuid,
        token: tokenFor('some-unrelated-id'),
        text: 'hi',
        signed_anchor_id: anchorId,
        commit: false,
      },
      dbStub(),
      {
        listPtys: () => [livePty],
        ptyInject,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.decision).toBe('rejected_auth');
  });
});
