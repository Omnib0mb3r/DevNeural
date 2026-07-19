/**
 * Bell followup dedup + expiry + resolve (Fix 4,
 * SPEC-2026-07-18-bell-actionable-dedup).
 *
 * The bell surface filter already drops conversation rows, but
 * GET /notifications?surface=bell returned 50+ followup rows dominated
 * by repeated "Claude waiting on you (idle_prompt)" and "Worker never
 * received an inject" that never dedupe or expire. These pins lock the
 * three mechanics that tame the pileup, all keyed on dedup_key so a
 * user-set followup (a fired reminder / needs-you, no dedup_key) is
 * never collapsed, expired, or auto-resolved:
 *   1. collapse identical dedup_key followups to one newest-wins row
 *      carrying a dup_count
 *   2. a TTL backstop hides a stale dedup_key followup from the bell
 *   3. resolveNotifications(key) clears the condition-based rows when
 *      the condition resolves; a newer emit after the resolve survives
 * The activity rail keeps the full stream untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let priorDataRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-notif-dedup-'));
  priorDataRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (priorDataRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorDataRoot;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
});

describe('bell followup dedup collapse', () => {
  it('collapses identical dedup_key followups into one newest-wins row with a dup_count', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    for (let i = 1; i <= 4; i++) {
      mod.emitNotification({
        severity: 'warn',
        source: 'permission',
        notify_class: 'followup',
        title: `Claude waiting on you (idle_prompt) #${i}`,
        dedup_key: 'idle:anchor-A',
      });
    }
    const bell = mod.listNotifications({ surface: 'bell' });
    expect(bell.length).toBe(1);
    /* Newest wins. */
    expect(bell[0]!.title).toBe('Claude waiting on you (idle_prompt) #4');
    expect(bell[0]!.dup_count).toBe(4);
    /* The bell count reflects the single collapsed row, not 4. */
    expect(mod.unreadCount('bell')).toBe(1);
  });

  it('does NOT collapse followups without a dedup_key (user-set reminders / needs-you stay distinct)', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'warn',
      source: 'reminder',
      notify_class: 'followup',
      title: 'reminder one fired',
    });
    mod.emitNotification({
      severity: 'warn',
      source: 'lex-attention',
      notify_class: 'followup',
      title: 'Lex needs a decision',
    });
    const bell = mod.listNotifications({ surface: 'bell' });
    expect(bell.length).toBe(2);
    expect(bell.every((n) => n.dup_count === undefined)).toBe(true);
  });

  it('collapses per dedup_key: two different targets stay two rows', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'warn', source: 'permission', notify_class: 'followup',
      title: 'idle A #1', dedup_key: 'idle:anchor-A',
    });
    mod.emitNotification({
      severity: 'warn', source: 'permission', notify_class: 'followup',
      title: 'idle A #2', dedup_key: 'idle:anchor-A',
    });
    mod.emitNotification({
      severity: 'warn', source: 'permission', notify_class: 'followup',
      title: 'idle B #1', dedup_key: 'idle:anchor-B',
    });
    const bell = mod.listNotifications({ surface: 'bell' });
    expect(bell.length).toBe(2);
    expect(bell.map((n) => n.title).sort()).toEqual(['idle A #2', 'idle B #1']);
  });

  it('the activity rail keeps every raw dedup_key row (no collapse there)', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    for (let i = 1; i <= 3; i++) {
      mod.emitNotification({
        severity: 'warn', source: 'permission', notify_class: 'followup',
        title: `idle #${i}`, dedup_key: 'idle:anchor-A',
      });
    }
    expect(mod.listNotifications({ surface: 'activity' }).length).toBe(3);
  });
});

describe('bell followup TTL backstop', () => {
  it('hides a dedup_key followup from the bell once it is older than the TTL', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'warn', source: 'cross-inject', notify_class: 'followup',
      title: 'Worker never received an inject', dedup_key: 'inject-fail:anchor-A',
    });
    /* Fresh: visible. */
    expect(mod.listNotifications({ surface: 'bell' }).length).toBe(1);
    /* Past the TTL: gone from the bell. */
    const future = Date.now() + mod.FOLLOWUP_TTL_MS + 1;
    expect(
      mod.listNotifications({ surface: 'bell', now: future }).length,
    ).toBe(0);
    /* But still on the activity rail (full history). */
    expect(
      mod.listNotifications({ surface: 'activity', now: future }).length,
    ).toBe(1);
  });

  it('the TTL never expires a user-set followup with no dedup_key', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'warn', source: 'reminder', notify_class: 'followup',
      title: 'reminder you set',
    });
    const future = Date.now() + mod.FOLLOWUP_TTL_MS + 1;
    expect(
      mod.listNotifications({ surface: 'bell', now: future }).map((n) => n.title),
    ).toEqual(['reminder you set']);
  });
});

describe('resolveNotifications (auto-clear on condition resolve)', () => {
  it('clears every followup for a dedup_key emitted before the resolve', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'warn', source: 'permission', notify_class: 'followup',
      title: 'idle #1', dedup_key: 'idle:anchor-A',
    });
    mod.emitNotification({
      severity: 'warn', source: 'permission', notify_class: 'followup',
      title: 'idle #2', dedup_key: 'idle:anchor-A',
    });
    expect(mod.listNotifications({ surface: 'bell' }).length).toBe(1);
    mod.resolveNotifications('idle:anchor-A');
    expect(mod.listNotifications({ surface: 'bell' }).length).toBe(0);
  });

  it('a NEW emit after the resolve survives (worker went idle again)', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'warn', source: 'permission', notify_class: 'followup',
      title: 'idle old', dedup_key: 'idle:anchor-A',
    });
    mod.resolveNotifications('idle:anchor-A');
    expect(mod.listNotifications({ surface: 'bell' }).length).toBe(0);
    mod.emitNotification({
      severity: 'warn', source: 'permission', notify_class: 'followup',
      title: 'idle fresh', dedup_key: 'idle:anchor-A',
    });
    const bell = mod.listNotifications({ surface: 'bell' });
    expect(bell.map((n) => n.title)).toEqual(['idle fresh']);
  });

  it('resolve is scoped to its key: a different followup is untouched', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'warn', source: 'permission', notify_class: 'followup',
      title: 'idle A', dedup_key: 'idle:anchor-A',
    });
    mod.emitNotification({
      severity: 'warn', source: 'cross-inject', notify_class: 'followup',
      title: 'inject fail B', dedup_key: 'inject-fail:anchor-B',
    });
    mod.resolveNotifications('idle:anchor-A');
    const bell = mod.listNotifications({ surface: 'bell' });
    expect(bell.map((n) => n.title)).toEqual(['inject fail B']);
  });
});
