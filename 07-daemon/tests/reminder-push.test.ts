/**
 * Reminder web-push dispatch.
 *
 * Covers:
 *   - fire with at least one subscription -> single notification emitted,
 *     ledger updated, idempotent on repeat.
 *   - fire with no subscriptions -> notification still emitted; the
 *     toast-fallback inside maybePushNotification handles the no-sub
 *     case (covered there). We assert the emit call shape, not the
 *     transport.
 *   - dedupe across loadPushedReminderIds: a restart-style reload
 *     into a fresh pushedIds Set still skips the reminder if the
 *     ledger has it.
 *   - guards: no due_at, completed reminder both short-circuit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Reminder } from '../src/dashboard/reminders.js';
import {
  firePushForReminder,
  loadPushedReminderIds,
  markReminderPushed,
} from '../src/dashboard/reminder-push.js';

let tmpDir: string;
let ledgerFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-reminder-push-'));
  ledgerFile = path.join(tmpDir, 'reminder-pushes.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function reminder(over: Partial<Reminder> = {}): Reminder {
  const base: Reminder = {
    id: 'r-1',
    title: 'Take out trash',
    due_at: new Date(Date.now() - 60_000).toISOString(),
    tags: [],
    created_at: new Date(Date.now() - 120_000).toISOString(),
    archived: false,
  };
  return { ...base, ...over };
}

describe('firePushForReminder', () => {
  it('emits a warn-severity notification on first fire', () => {
    const emit = vi.fn().mockReturnValue({ id: 'notif-1' });
    const mark = vi.fn();
    const pushedIds = new Set<string>();
    const r = firePushForReminder(reminder(), {
      pushedIds,
      markPushed: mark,
      emit,
    });
    expect(r.outcome).toBe('fired');
    expect(r.notification_id).toBe('notif-1');
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0] as {
      severity: string;
      source: string;
      title: string;
      link: string;
    };
    expect(arg.severity).toBe('warn');
    expect(arg.source).toBe('reminder');
    expect(arg.title).toMatch(/Take out trash/);
    expect(arg.link).toBe('/reminders');
    expect(mark).toHaveBeenCalledWith('r-1');
    expect(pushedIds.has('r-1')).toBe(true);
  });

  it('is idempotent: second fire on the same reminder is a no-op', () => {
    const emit = vi.fn().mockReturnValue({ id: 'notif-1' });
    const mark = vi.fn();
    const pushedIds = new Set<string>();
    firePushForReminder(reminder(), { pushedIds, markPushed: mark, emit });
    const r2 = firePushForReminder(reminder(), {
      pushedIds,
      markPushed: mark,
      emit,
    });
    expect(r2.outcome).toBe('already-fired');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it('skips when due_at is absent', () => {
    const emit = vi.fn();
    const r = firePushForReminder(reminder({ due_at: undefined }), {
      pushedIds: new Set(),
      markPushed: vi.fn(),
      emit,
    });
    expect(r.outcome).toBe('no-due-date');
    expect(emit).not.toHaveBeenCalled();
  });

  it('skips when reminder is already completed', () => {
    const emit = vi.fn();
    const r = firePushForReminder(
      reminder({ completed_at: new Date().toISOString() }),
      { pushedIds: new Set(), markPushed: vi.fn(), emit },
    );
    expect(r.outcome).toBe('completed');
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits even when no push subscription is present (toast-only path)', () => {
    /* This module does not know about subscriptions; it just emits a
     * notification. The push.ts maybePushNotification path falls back
     * to BurntToast when delivered=0. We assert here that the emit
     * call happens unconditionally so the downstream toast path can
     * run regardless of subscription count. */
    const emit = vi.fn().mockReturnValue({ id: 'notif-2' });
    const r = firePushForReminder(reminder({ id: 'r-no-subs' }), {
      pushedIds: new Set(),
      markPushed: vi.fn(),
      emit,
    });
    expect(r.outcome).toBe('fired');
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('ledger persistence', () => {
  it('markReminderPushed appends a parseable line', () => {
    markReminderPushed('r-1', ledgerFile);
    markReminderPushed('r-2', ledgerFile);
    const ids = loadPushedReminderIds(ledgerFile);
    expect(ids.has('r-1')).toBe(true);
    expect(ids.has('r-2')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('loadPushedReminderIds returns empty when ledger does not exist', () => {
    expect(loadPushedReminderIds(ledgerFile).size).toBe(0);
  });

  it('skips malformed lines and continues parsing', () => {
    fs.writeFileSync(
      ledgerFile,
      JSON.stringify({ reminder_id: 'good-1', pushed_at: 'x' }) +
        '\n' +
        '{not valid json\n' +
        JSON.stringify({ reminder_id: 'good-2', pushed_at: 'x' }) +
        '\n',
      'utf-8',
    );
    const ids = loadPushedReminderIds(ledgerFile);
    expect(ids.has('good-1')).toBe(true);
    expect(ids.has('good-2')).toBe(true);
    expect(ids.size).toBe(2);
  });

  it('cross-restart dedupe: ledger pre-populates the pushedIds set', () => {
    markReminderPushed('r-survivor', ledgerFile);
    /* Simulate daemon restart: fresh in-memory Set seeded from disk. */
    const pushedIds = loadPushedReminderIds(ledgerFile);
    const emit = vi.fn();
    const r = firePushForReminder(reminder({ id: 'r-survivor' }), {
      pushedIds,
      markPushed: () => markReminderPushed('r-survivor', ledgerFile),
      emit,
    });
    expect(r.outcome).toBe('already-fired');
    expect(emit).not.toHaveBeenCalled();
  });
});
