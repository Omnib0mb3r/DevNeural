/**
 * Fix 21 (2026-05-24): push respects notify_class taxonomy.
 *
 * Pins the gate matrix in maybePushNotification:
 *
 *   conversation               -> skip (activity-rail only)
 *   report                     -> send (end-of-session / handover)
 *   followup                   -> send (action-required)
 *   signal + severity=info     -> skip (low-signal pings)
 *   signal + severity=warn     -> send (loud signals warrant a buzz)
 *   signal + severity=alert    -> send
 *
 * The test exercises maybePushNotification with an empty
 * subscriptions file. When the gate ALLOWS push, sendPushToAll
 * returns delivered=0 and the toast-fallback fires. When the gate
 * SKIPS push, neither fires. Therefore the showToast call count is
 * a clean proxy for the gate decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const showToastMock = vi.fn(async () => undefined);

vi.mock('../src/dashboard/toast-fallback.js', () => ({
  showToast: showToastMock,
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-push-gate-'));
  fs.mkdirSync(path.join(tmpDir, 'dashboard'), { recursive: true });
  /* Empty subscriptions file so sendPushToAll returns delivered=0
   * without trying to hit a real web-push server. */
  fs.writeFileSync(
    path.join(tmpDir, 'dashboard', 'push-subscriptions.json'),
    '[]',
    'utf-8',
  );
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  showToastMock.mockClear();
});

afterEach(() => {
  delete process.env.DEVNEURAL_DATA_ROOT;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* tolerate windows file-lock races */
  }
});

type GateExpect = 'skip' | 'send';

interface Case {
  notify_class: 'conversation' | 'report' | 'followup' | 'signal' | undefined;
  severity: 'info' | 'warn' | 'alert';
  expected: GateExpect;
}

async function runCase(c: Case, mode: 'auto' | 'force' = 'auto'): Promise<GateExpect> {
  vi.resetModules();
  const { maybePushNotification } = await import('../src/dashboard/push.js');
  const n: Parameters<typeof maybePushNotification>[0] = {
    id: `n-${c.notify_class}-${c.severity}`,
    ts: new Date().toISOString(),
    severity: c.severity,
    source: 'fix-21-test',
    title: `case ${c.notify_class}/${c.severity}`,
    dismissed: false,
    dismissed_scopes: [],
    ...(c.notify_class ? { notify_class: c.notify_class } : {}),
  };
  showToastMock.mockClear();
  await maybePushNotification(n, { mode });
  return showToastMock.mock.calls.length > 0 ? 'send' : 'skip';
}

describe('maybePushNotification notify_class gate (Fix 21)', () => {
  it.each<Case>([
    { notify_class: 'conversation', severity: 'info', expected: 'skip' },
    { notify_class: 'conversation', severity: 'warn', expected: 'skip' },
    { notify_class: 'conversation', severity: 'alert', expected: 'skip' },
    { notify_class: 'report', severity: 'info', expected: 'send' },
    { notify_class: 'report', severity: 'warn', expected: 'send' },
    { notify_class: 'followup', severity: 'info', expected: 'send' },
    { notify_class: 'followup', severity: 'warn', expected: 'send' },
    { notify_class: 'signal', severity: 'info', expected: 'skip' },
    { notify_class: 'signal', severity: 'warn', expected: 'send' },
    { notify_class: 'signal', severity: 'alert', expected: 'send' },
    { notify_class: undefined, severity: 'warn', expected: 'skip' },
  ])(
    'class=%j severity=%j -> %j (auto mode)',
    async (c) => {
      const actual = await runCase(c);
      expect(actual).toBe(c.expected);
    },
  );

  it('mode=force preserves the conversation skip (class beats mode)', async () => {
    const actual = await runCase(
      { notify_class: 'conversation', severity: 'info', expected: 'skip' },
      'force',
    );
    expect(actual).toBe('skip');
  });
});
