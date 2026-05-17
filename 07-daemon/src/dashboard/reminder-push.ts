/**
 * Reminder web-push dispatch (TODO entry: dashboard reminders into the
 * existing web push channel).
 *
 * The daemon's reminder sweep used to fire only an in-process
 * awareness event when a reminder went due. That surfaced as the
 * `open_reminders` line in live_state and an in-dashboard toast, but
 * it never reached the iOS PWA or desktop push channel - so a phone
 * sitting on the user's desk would not buzz when something due
 * landed.
 *
 * This module:
 *   1. Persists every reminder we have already pushed to
 *      `<DATA_ROOT>/dashboard/reminder-pushes.jsonl`.
 *   2. Loads that ledger at startup so a daemon restart mid-sweep
 *      cannot re-fire the same reminder.
 *   3. Exposes firePushForReminder which dedupes against the ledger,
 *      emits a warn-severity notification (which the existing
 *      maybePushNotification path turns into a web push + toast
 *      fallback), and stamps the ledger.
 *
 * The dispatch path is mockable: every side effect (ledger load /
 * append, notification emit) is parameterised so tests can verify
 * dedupe + with-subscription + toast-fallback paths without touching
 * the real fs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_ROOT, ensureDir } from '../paths.js';
import type { Reminder } from './reminders.js';
import { emitNotification, type Notification } from './notifications.js';

const DASHBOARD_DIR = path.posix.join(DATA_ROOT, 'dashboard');
const PUSH_LEDGER_FILE = path.posix.join(
  DASHBOARD_DIR,
  'reminder-pushes.jsonl',
);

export interface ReminderPushLedgerEntry {
  reminder_id: string;
  pushed_at: string;
}

/* Reads every persisted line. The file is small (one line per fired
 * reminder, prune on archive/complete is fine to skip - the ledger is
 * append-only and the natural cap is the number of distinct reminders
 * the user has ever set). */
export function loadPushedReminderIds(
  file: string = PUSH_LEDGER_FILE,
): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(file)) return out;
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ReminderPushLedgerEntry;
        if (parsed.reminder_id) out.add(parsed.reminder_id);
      } catch {
        continue;
      }
    }
  } catch {
    /* corrupt ledger: treat as empty rather than blocking the sweep */
  }
  return out;
}

export function markReminderPushed(
  reminderId: string,
  file: string = PUSH_LEDGER_FILE,
): void {
  ensureDir(path.posix.dirname(file));
  const entry: ReminderPushLedgerEntry = {
    reminder_id: reminderId,
    pushed_at: new Date().toISOString(),
  };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
}

export interface FirePushDeps {
  /** Set of reminder ids we have already pushed. Mutated in place on
   * fire so subsequent calls in the same sweep see the new id. */
  pushedIds: Set<string>;
  /** Persistence hook. Defaults to markReminderPushed against the real
   * ledger file; tests inject a no-op. */
  markPushed?: (id: string) => void;
  /** Notification emit. Defaults to emitNotification (which routes
   * through push.ts maybePushNotification). Tests inject a spy. */
  emit?: (input: {
    severity: 'info' | 'warn' | 'alert';
    source: string;
    title: string;
    body?: string;
    link?: string;
  }) => Notification | { id: string };
}

export type FirePushOutcome =
  | 'fired'
  | 'already-fired'
  | 'no-due-date'
  | 'completed';

export interface FirePushResult {
  outcome: FirePushOutcome;
  notification_id: string | null;
}

/* Fire one web-push for a reminder. Idempotent on reminder_id. */
export function firePushForReminder(
  reminder: Reminder,
  deps: FirePushDeps,
): FirePushResult {
  if (!reminder.due_at) {
    return { outcome: 'no-due-date', notification_id: null };
  }
  if (reminder.completed_at) {
    return { outcome: 'completed', notification_id: null };
  }
  if (deps.pushedIds.has(reminder.id)) {
    return { outcome: 'already-fired', notification_id: null };
  }
  deps.pushedIds.add(reminder.id);
  const mark = deps.markPushed ?? markReminderPushed;
  mark(reminder.id);
  const emit = deps.emit ?? emitNotification;
  const n = emit({
    severity: 'warn',
    source: 'reminder',
    notify_class: 'followup',
    title: reminder.title.slice(0, 120) || 'Reminder due',
    body: dueBody(reminder),
    link: '/reminders',
  });
  return { outcome: 'fired', notification_id: n.id };
}

function dueBody(reminder: Reminder): string {
  if (!reminder.due_at) return 'Reminder due';
  const due = new Date(reminder.due_at);
  if (Number.isNaN(due.valueOf())) return 'Reminder due';
  return `Due ${due.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}
