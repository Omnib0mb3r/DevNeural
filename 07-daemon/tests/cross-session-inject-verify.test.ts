/* DRIVE-QUEUE rider (2026-07-17): bridge inject delivery confirmation.
 * "Accepted" has never meant "delivered" - reproduced again tonight on
 * an idle worker: the audit row said accepted while the worker's
 * composer sat with an unsubmitted paste. crossSessionInject now hands
 * every ACCEPTED inject to a delivery verifier (same jsonl-fingerprint
 * contract the voice path uses); rejects never verify. These tests pin
 * the hook: right transport, verification starts only on accept, and
 * the fingerprint is the injected text.
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

function makeDbStub(): IndexDbType {
  return {
    insertCrossSessionLog: vi.fn(),
  } as unknown as IndexDbType;
}

function stubDeliverable(): NonNullable<
  CrossSessionInjectDeps['resolveDeliverableBridge']
> {
  return () => ({
    verdict: 'deliverable',
    selected: null,
    claimingRecords: [],
  });
}

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';

describe('crossSessionInject: accepted injects start delivery verification', () => {
  it('pty transport verifies with the injected text and transport tag', async () => {
    const verifyCalls: Array<{
      sessionId: string | null;
      text: string;
      transport: string;
    }> = [];
    const res = await crossSessionInject(
      {
        target_session: SESSION,
        token: validToken(SESSION),
        text: 'run the tests and report back',
      },
      makeDbStub(),
      {
        listPtys: () =>
          [
            {
              ptyId: 'pty-1',
              sessionId: SESSION,
              exited: false,
            } as unknown as PtyEntry,
          ] as PtyEntry[],
        ptyInject: () => ({ ok: true }),
        scheduleCommit: () => undefined,
        verifyDelivery: (args) => {
          verifyCalls.push({
            sessionId: args.sessionId,
            text: args.text,
            transport: args.transport,
          });
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(verifyCalls).toHaveLength(1);
    expect(verifyCalls[0]!.transport).toBe('pty');
    expect(verifyCalls[0]!.text).toBe('run the tests and report back');
    expect(verifyCalls[0]!.sessionId).toBe(SESSION);
  });

  it('bridge transport verifies too', async () => {
    const verifyCalls: string[] = [];
    const res = await crossSessionInject(
      {
        target_session: SESSION,
        token: validToken(SESSION),
        text: 'status check please',
      },
      makeDbStub(),
      {
        listPtys: () => [] as PtyEntry[],
        queueSessionPrompt: () => ({ ok: true }),
        resolveDeliverableBridge: stubDeliverable(),
        scheduleCommit: () => undefined,
        verifyDelivery: (args) => {
          verifyCalls.push(args.transport);
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(verifyCalls).toEqual(['bridge']);
  });

  it('a rejected inject never starts verification', async () => {
    const verifyCalls: string[] = [];
    const res = await crossSessionInject(
      {
        target_session: SESSION,
        token: 'not-a-valid-token',
        text: 'this should be rejected',
      },
      makeDbStub(),
      {
        listPtys: () => [] as PtyEntry[],
        scheduleCommit: () => undefined,
        verifyDelivery: (args) => {
          verifyCalls.push(args.transport);
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(verifyCalls).toHaveLength(0);
  });
});
