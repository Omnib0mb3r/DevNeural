/**
 * Notification surface filter (Fix 9).
 *
 * Verifies that:
 *   - notify_class defaults to 'conversation' when unset (safer to
 *     filter than to leak)
 *   - listNotifications({surface:'bell'}) drops conversation rows
 *   - listNotifications({surface:'activity'}) keeps every row
 *   - report / followup / signal all pass the bell filter
 *   - dismissed_scopes interact correctly with the surface filter
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let priorDataRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-notif-filter-'));
  priorDataRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  /* notifications.ts captures DATA_ROOT at module load, so each test
   * needs a fresh module graph anchored to the per-test tmp dir. */
  vi.resetModules();
});

afterEach(() => {
  if (priorDataRoot === undefined) {
    delete process.env.DEVNEURAL_DATA_ROOT;
  } else {
    process.env.DEVNEURAL_DATA_ROOT = priorDataRoot;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* tmpDir may already be gone */
  }
});

describe('notify_class surface filter', () => {
  it('filters conversation rows out of the bell surface', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'info',
      source: 'lex',
      notify_class: 'conversation',
      title: 'Lex spoke',
    });
    mod.emitNotification({
      severity: 'info',
      source: 'curator',
      notify_class: 'signal',
      title: 'Wiki match',
    });
    mod.emitNotification({
      severity: 'warn',
      source: 'lex-attention',
      notify_class: 'followup',
      title: 'Lex needs you',
    });
    mod.emitNotification({
      severity: 'info',
      source: 'lex',
      notify_class: 'report',
      title: 'Morning report',
    });

    const bell = mod.listNotifications({ surface: 'bell' });
    const titles = bell.map((n) => n.title);
    expect(titles).not.toContain('Lex spoke');
    /* 2026-07-16 operator directive: automated signal chatter (info /
     * warn) stays on the activity rail; the bell is reserved for
     * reports, followups, and alert-severity emergencies. */
    expect(titles).not.toContain('Wiki match');
    expect(titles).toContain('Lex needs you');
    expect(titles).toContain('Morning report');
    expect(bell.length).toBe(2);
  });

  it('signal rows reach the bell only at alert severity (2026-07-16: the bell pinned at 9+ on signal chatter)', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'info',
      source: 'reinforcement',
      notify_class: 'signal',
      title: 'page reinforced',
    });
    mod.emitNotification({
      severity: 'warn',
      source: 'supervision',
      notify_class: 'signal',
      title: 'worker slow',
    });
    mod.emitNotification({
      severity: 'alert',
      source: 'daemon',
      notify_class: 'signal',
      title: 'daemon degraded',
    });
    const bell = mod.listNotifications({ surface: 'bell' });
    expect(bell.map((n) => n.title)).toEqual(['daemon degraded']);
    /* The activity rail still carries all three. */
    expect(mod.listNotifications({ surface: 'activity' }).length).toBe(3);
  });

  it('activity surface keeps every row including conversation', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'info',
      source: 'lex',
      notify_class: 'conversation',
      title: 'Lex spoke A',
    });
    mod.emitNotification({
      severity: 'info',
      source: 'curator',
      notify_class: 'signal',
      title: 'Wiki match B',
    });

    const activity = mod.listNotifications({ surface: 'activity' });
    expect(activity.length).toBe(2);
    const titles = activity.map((n) => n.title);
    expect(titles).toContain('Lex spoke A');
    expect(titles).toContain('Wiki match B');
  });

  it('omitting surface returns every row (legacy callers)', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'info',
      source: 'lex',
      notify_class: 'conversation',
      title: 'Lex spoke C',
    });
    mod.emitNotification({
      severity: 'info',
      source: 'curator',
      notify_class: 'signal',
      title: 'Signal D',
    });
    const all = mod.listNotifications({});
    expect(all.length).toBe(2);
  });

  it('un-tagged emits default to conversation and drop out of the bell', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'info',
      source: 'legacy',
      title: 'Untagged emit',
    });
    /* Persisted notify_class is conversation */
    const all = mod.listNotifications({});
    expect(all[0]?.notify_class).toBe('conversation');
    const bell = mod.listNotifications({ surface: 'bell' });
    expect(bell.length).toBe(0);
  });

  it('unreadCount on the bell scope respects the surface filter', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'info',
      source: 'lex',
      notify_class: 'conversation',
      title: 'noise',
    });
    mod.emitNotification({
      severity: 'info',
      source: 'curator',
      notify_class: 'signal',
      title: 'signal chatter (activity rail only)',
    });
    mod.emitNotification({
      severity: 'warn',
      source: 'lex-attention',
      notify_class: 'followup',
      title: 'real followup',
    });
    expect(mod.unreadCount('bell')).toBe(1);
  });

  it('dismissAllNotifications clears one scope without touching the other', async () => {
    const mod = await import('../src/dashboard/notifications.js');
    mod.emitNotification({
      severity: 'info',
      source: 'lex',
      notify_class: 'report',
      title: 'report one',
    });
    mod.emitNotification({
      severity: 'warn',
      source: 'lex-attention',
      notify_class: 'followup',
      title: 'followup two',
    });
    expect(mod.unreadCount('bell')).toBe(2);
    const cleared = mod.dismissAllNotifications('bell');
    expect(cleared).toBe(2);
    expect(mod.unreadCount('bell')).toBe(0);
    /* Activity scope untouched: both rows still visible there. */
    const activity = mod
      .listNotifications({ surface: 'activity' })
      .filter((n) => !(n.dismissed_scopes ?? []).includes('activity'));
    expect(activity.length).toBe(2);
  });
});
