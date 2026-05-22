/* Regression test: cross-session inject must auto-fire a bare CR
 * through the same transport after the primary text inject lands.
 *
 * Symptom: the bridge VSIX delivers the primary text via bracketed
 * paste, which the worker treats as a multi-character paste WITHOUT
 * the trailing CR. The text sits in the input box and Enter never
 * fires, so unattended supervision stalls. Lex had been firing a
 * second bare-CR inject manually after every real inject as a
 * workaround.
 *
 * Fix: crossSessionInject schedules a bare '\r' inject through the
 * SAME transport ~850 ms after the primary inject succeeds. These
 * tests assert that, on both the PTY and bridge transports, a stub
 * worker's byte buffer GROWS with the CR within the configured
 * window. Synchronous scheduler keeps the test fast.
 *
 * Auth: getAuthSecret is mocked rather than backed by a temp
 * DATA_ROOT, so this test does not mutate process.env in ways that
 * would leak into sibling tests run by the same vitest worker.
 */
import { describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';

const TEST_SECRET = 'a'.repeat(64);
vi.mock('../src/dashboard/auth-secret.js', () => ({
  getAuthSecret: () => TEST_SECRET,
}));

import { crossSessionInject } from '../src/lex/cross-session-inject.js';
import type { CrossSessionInjectDeps } from '../src/lex/cross-session-inject.js';
import type { IndexDb as IndexDbType } from '../src/store/index-db.js';
import type { PtyEntry } from '../src/dashboard/pty-host.js';

function validToken(targetSession: string): string {
  const minute = Math.floor(Date.now() / 60_000);
  return crypto
    .createHmac('sha256', TEST_SECRET)
    .update(`${targetSession}:${minute}`)
    .digest('hex');
}

/* Minimal db stub: crossSessionInject only calls insertCrossSessionLog
 * on the supplied IndexDb. Capturing those rows is not load-bearing
 * for these assertions (the audit row covers the primary inject only,
 * the CR nudge is fire-and-forget). */
function makeDbStub(): IndexDbType {
  return {
    insertCrossSessionLog: vi.fn(),
  } as unknown as IndexDbType;
}

/* Bug 3e (2026-05-22): the bridge fallback now consults the
 * presence-file-based deliverability resolver before queueing a
 * marker. These tests don't run a real presence directory, so we
 * stub the dep to a deliverable verdict; the bridge-fallback tests
 * here are about the CR nudge mechanics, not about the deliverability
 * gate (covered separately). */
function stubDeliverable(): NonNullable<CrossSessionInjectDeps['resolveDeliverableBridge']> {
  return () => ({
    verdict: 'deliverable',
    selected: null,
    claimingRecords: [],
  });
}

/* Synchronous scheduler that captures the deferred callback so the
 * test can drive it on demand. Lets us assert the primary inject
 * happens first and only fires the nudge after we deliberately tick
 * the clock. */
function makeManualScheduler(): {
  schedule: NonNullable<CrossSessionInjectDeps['scheduleCommit']>;
  fire: () => void;
  pending: () => number;
} {
  const queue: Array<{ fn: () => void; delay: number }> = [];
  return {
    schedule: (fn, delay) => {
      queue.push({ fn, delay });
    },
    fire: () => {
      while (queue.length) {
        const next = queue.shift();
        if (next) next.fn();
      }
    },
    pending: () => queue.length,
  };
}

describe('crossSessionInject auto-CR nudge', () => {
  it('grows the PTY transport bytes by text and a follow-up CR', () => {
    const db = makeDbStub();
    const ptyId = 'pty-test-1';
    let buffer = '';
    const ptyInject = vi.fn((id: string, text: string) => {
      if (id !== ptyId) return { ok: false as const, error: 'wrong pty' };
      buffer += text;
      return { ok: true as const };
    });
    const listPtys = (): PtyEntry[] => [
      {
        ptyId,
        sessionId: 'sess-1',
        cwd: '/tmp/x',
        command: 'claude',
        startedAt: Date.now(),
        lastActivity: Date.now(),
        exited: false,
      } as unknown as PtyEntry,
    ];
    const scheduler = makeManualScheduler();

    const result = crossSessionInject(
      {
        target_session: 'sess-1',
        token: validToken('sess-1'),
        text: 'hello worker',
        caller_label: 'test',
      },
      db,
      {
        listPtys,
        ptyInject,
        scheduleCommit: scheduler.schedule,
        commitDelayMs: 850,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.decision).toBe('accepted');
    expect(result.transport).toBe('pty');
    /* Primary inject landed; buffer carries the text. CR has not
     * yet been delivered because the scheduler is manual. */
    expect(buffer).toBe('hello worker');
    expect(ptyInject).toHaveBeenCalledTimes(1);
    expect(scheduler.pending()).toBe(1);

    /* Advance the scheduler. The nudge MUST grow the buffer with
     * a bare CR via the SAME transport (ptyInject). */
    scheduler.fire();
    expect(buffer).toBe('hello worker\r');
    expect(ptyInject).toHaveBeenCalledTimes(2);
    expect(ptyInject.mock.calls[1]).toEqual([ptyId, '\r', false]);
  });

  it('grows the bridge transport bytes by text and a follow-up CR', () => {
    const db = makeDbStub();
    const target = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    let bridgeBuffer = '';
    const queueSessionPrompt = vi.fn((id: string, text: string) => {
      if (id !== target)
        return {
          ok: false as const,
          error: 'wrong sess',
          bridge: {} as never,
        };
      bridgeBuffer += text;
      return { ok: true as const, queued_at: new Date().toISOString() };
    });
    const queueSessionSuggestion = vi.fn(() => ({
      ok: false as const,
      error: 'should not fire',
      bridge: {} as never,
    }));
    const scheduler = makeManualScheduler();

    const result = crossSessionInject(
      {
        target_session: target,
        token: validToken(target),
        text: 'bridge body',
        caller_label: 'test-bridge',
      },
      db,
      {
        listPtys: () => [],
        queueSessionPrompt,
        queueSessionSuggestion,
        scheduleCommit: scheduler.schedule,
        commitDelayMs: 850,
        resolveDeliverableBridge: stubDeliverable(),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe('bridge');
    expect(bridgeBuffer).toBe('bridge body');
    expect(queueSessionPrompt).toHaveBeenCalledTimes(1);
    expect(scheduler.pending()).toBe(1);

    scheduler.fire();
    expect(bridgeBuffer).toBe('bridge body\r');
    expect(queueSessionPrompt).toHaveBeenCalledTimes(2);
    expect(queueSessionPrompt.mock.calls[1]).toEqual([target, '\r']);
    expect(queueSessionSuggestion).not.toHaveBeenCalled();
  });

  it('does NOT schedule a CR when commit=false (suggestion path)', () => {
    const db = makeDbStub();
    const target = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const queueSessionPrompt = vi.fn();
    const queueSessionSuggestion = vi.fn(() => ({
      ok: true as const,
      queued_at: new Date().toISOString(),
    }));
    const scheduler = makeManualScheduler();

    const result = crossSessionInject(
      {
        target_session: target,
        token: validToken(target),
        text: 'soft suggestion',
        commit: false,
      },
      db,
      {
        listPtys: () => [],
        queueSessionPrompt,
        queueSessionSuggestion,
        scheduleCommit: scheduler.schedule,
        resolveDeliverableBridge: stubDeliverable(),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.transport).toBe('bridge');
    expect(queueSessionSuggestion).toHaveBeenCalledTimes(1);
    /* commit=false is the deliberate "drop text without firing
     * Enter" mode used by the curator suggestion path. The CR
     * nudge must NOT fire there or it would turn every quiet
     * suggestion into a submit. */
    expect(scheduler.pending()).toBe(0);
    expect(queueSessionPrompt).not.toHaveBeenCalled();
  });

  it('does not schedule a CR when the primary inject is rejected', () => {
    const db = makeDbStub();
    const target = 'sess-fail';
    const ptyInject = vi.fn(() => ({ ok: false as const, error: 'no pty' }));
    const listPtys = (): PtyEntry[] => [
      {
        ptyId: 'p',
        sessionId: target,
        cwd: '/tmp',
        command: 'claude',
        startedAt: Date.now(),
        lastActivity: Date.now(),
        exited: false,
      } as unknown as PtyEntry,
    ];
    const scheduler = makeManualScheduler();

    const result = crossSessionInject(
      {
        target_session: target,
        token: validToken(target),
        text: 'will fail',
      },
      db,
      {
        listPtys,
        ptyInject,
        scheduleCommit: scheduler.schedule,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.decision).toBe('rejected_pty');
    /* No CR nudge after a rejection: the worker never received the
     * primary, firing a stray CR into a different session would be
     * incorrect. */
    expect(scheduler.pending()).toBe(0);
    expect(ptyInject).toHaveBeenCalledTimes(1);
  });

  it('defaults the commit delay to a value in the 750-1000 ms window', () => {
    const db = makeDbStub();
    const ptyId = 'pty-delay';
    let captured = -1;
    const ptyInject = vi.fn(() => ({ ok: true as const }));
    const listPtys = (): PtyEntry[] => [
      {
        ptyId,
        sessionId: ptyId,
        cwd: '/tmp',
        command: 'claude',
        startedAt: Date.now(),
        lastActivity: Date.now(),
        exited: false,
      } as unknown as PtyEntry,
    ];
    crossSessionInject(
      {
        target_session: ptyId,
        token: validToken(ptyId),
        text: 'pin delay',
      },
      db,
      {
        listPtys,
        ptyInject,
        scheduleCommit: (_fn, delay) => {
          captured = delay;
        },
      },
    );
    expect(captured).toBeGreaterThanOrEqual(750);
    expect(captured).toBeLessThanOrEqual(1000);
  });
});
