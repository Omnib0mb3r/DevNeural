/**
 * Notifications: server-side persistence + WS broadcast hook.
 *
 * Web push delivery (VAPID + service worker) is a Phase 3.7 add-on.
 * This module handles the persistence and the in-process event bus
 * that the dashboard subscribes to.
 *
 * Dismiss has per-scope semantics so the top-bar bell and the right-rail
 * live activity can be acknowledged independently. Bell catches every
 * notification (system + activity); activity rail filters to the brain
 * stream. Dismissing in one surface does not affect the other.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_ROOT, ensureDir } from '../paths.js';

const DASHBOARD_DIR = path.posix.join(DATA_ROOT, 'dashboard');
const FILE = path.posix.join(DASHBOARD_DIR, 'notifications.jsonl');
const RETENTION_DAYS = 30;

export type Severity = 'info' | 'warn' | 'alert';
export type NotificationScope = 'bell' | 'activity';
export const ALL_SCOPES: NotificationScope[] = ['bell', 'activity'];

/** Source-class taxonomy for the bell surface.
 *
 *   conversation - spoken reply in a brainstorm. NEVER hits the bell;
 *                  voice / transcript loop still renders it. This is
 *                  the SAFE default: when a caller forgets to set
 *                  notify_class, the emit is filtered out of the bell
 *                  rather than leaking conversational noise into it.
 *   report       - morning report, post-session brief, anything Lex
 *                  publishes for the user. Hits the bell.
 *   followup     - scheduled or condition-triggered item needing the
 *                  user's eye (lex-attention, reminders). Hits the
 *                  bell.
 *   signal       - automated supervision (worker stalled, daemon down,
 *                  push notifications, lint errors). Hits the bell.
 *
 * Per Fix 9, the bell filter keeps only report / followup / signal.
 * Existing call sites that emit legitimate system signals are
 * classified explicitly at the write site; new Lex-conversation
 * surfaces emit `conversation` and are dropped at the bell. */
export type NotifyClass = 'conversation' | 'report' | 'followup' | 'signal';
export const BELL_NOTIFY_CLASSES: ReadonlySet<NotifyClass> = new Set([
  'report',
  'followup',
  'signal',
]);

/** Push payload event-type taxonomy. 'reminder' is the legacy default
 * (scheduled reminder went due); 'attention' is the new real-time
 * Lex attention-needed signal (a question that requires a yes/no or
 * pick-one decision, or a supervision stall escalation). The service
 * worker uses this to render different icons / sounds / urgencies. */
export type PushEventType = 'reminder' | 'attention';

/** Per-call push override. 'auto' keeps the legacy severity-driven
 * gate (info skipped, warn+alert pushed). 'force' pushes regardless
 * of severity (used by attention notifications even at info-level
 * for quiet-hours follow-ups that DID escape suppression). 'suppress'
 * blocks push entirely - the notification still lands in the log so
 * the in-app surfaces see it, but no system push fires. Quiet-hours
 * gating routes through 'suppress'. */
export type PushMode = 'auto' | 'force' | 'suppress';

export interface Notification {
  id: string;
  ts: string;
  severity: Severity;
  source: string; // e.g. "ingest", "lint", "ollama", "system", "curator", "reinforcement", "lex-attention"
  title: string;
  body?: string;
  link?: string;
  /** Legacy flag: true once dismissed in BOTH scopes. Kept so existing
   * callers / dashboards still see "all-dismissed" semantics. */
  dismissed: boolean;
  /** Per-surface dismiss tracking. Empty = visible everywhere. */
  dismissed_scopes: NotificationScope[];
  /** Push taxonomy, persisted on the notification row so the
   * dashboard log can render attention rows with a distinct affordance
   * (icon, click target) even after a SW restart drops the in-memory
   * push payload. Defaults to 'reminder' when missing for backward
   * compat with older rows. */
  event_type?: PushEventType;
  /** Free-form metadata forwarded into the web-push payload so the
   * service worker can deep-link or render specialised UIs. Kept
   * narrow on purpose: brainstorm_id, turn_id, snippet. */
  push_data?: Record<string, string | number | boolean | null>;
  /** Source-class taxonomy gating bell visibility. Defaults to
   * 'conversation' for un-tagged legacy rows (safer: filtered out of
   * the bell rather than leaked into it). See NotifyClass for the
   * full taxonomy. */
  notify_class?: NotifyClass;
}

export const events = new EventEmitter();

function append(n: Notification): void {
  ensureDir(DASHBOARD_DIR);
  fs.appendFileSync(FILE, JSON.stringify(n) + '\n', 'utf-8');
}

export function emitNotification(input: {
  severity: Severity;
  source: string;
  title: string;
  body?: string;
  link?: string;
  /** Push taxonomy. Defaults to 'reminder' for back-compat with every
   * existing caller; the lex-attention pipeline passes 'attention' so
   * the SW can render a distinct urgency. */
  event_type?: PushEventType;
  /** Free-form metadata forwarded into the push payload. */
  push_data?: Record<string, string | number | boolean | null>;
  /** Push override. Defaults to 'auto' (severity-driven gate). The
   * lex-attention pipeline uses 'suppress' inside quiet hours. */
  push?: PushMode;
  /** Source class governing bell visibility. Default 'conversation'
   * is the safe choice: an un-tagged emit will be dropped at the
   * bell rather than allowed through as noise. Existing callers
   * explicitly tag their emits as report / followup / signal. */
  notify_class?: NotifyClass;
}): Notification {
  const notifyClass: NotifyClass = input.notify_class ?? 'conversation';
  const n: Notification = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    severity: input.severity,
    source: input.source,
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    ...(input.link ? { link: input.link } : {}),
    dismissed: false,
    dismissed_scopes: [],
    ...(input.event_type ? { event_type: input.event_type } : {}),
    ...(input.push_data ? { push_data: input.push_data } : {}),
    notify_class: notifyClass,
  };
  append(n);
  events.emit('notification', n);
  // Web push delivery (warn + alert only by default; 'force' / 'suppress'
  // overrides honoured). Imported lazily to avoid a circular load and to
  // keep the persistence layer functional even if push setup fails.
  const pushMode: PushMode = input.push ?? 'auto';
  if (pushMode !== 'suppress') {
    void (async () => {
      try {
        const { maybePushNotification } = await import('./push.js');
        await maybePushNotification(n, { mode: pushMode });
      } catch {
        /* push delivery is best-effort */
      }
    })();
  }
  return n;
}

interface NotificationOp {
  op: 'dismiss';
  id: string;
  ts: string;
  /** Omitted = legacy "dismiss everywhere"; one scope = surface-local. */
  scope?: NotificationScope | 'all';
}

function isOp(value: unknown): value is NotificationOp {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { op?: string }).op === 'dismiss',
  );
}

function applyDismiss(
  n: Notification,
  scope: NotificationScope | 'all' | undefined,
): void {
  const scopes = new Set<NotificationScope>(n.dismissed_scopes ?? []);
  if (!scope || scope === 'all') {
    for (const s of ALL_SCOPES) scopes.add(s);
  } else {
    scopes.add(scope);
  }
  n.dismissed_scopes = Array.from(scopes);
  n.dismissed = ALL_SCOPES.every((s) => scopes.has(s));
}

export interface ListNotificationsOptions {
  limit?: number;
  /** Surface gate. When 'bell', only notify_class in
   * BELL_NOTIFY_CLASSES are returned (drops conversation rows). When
   * 'activity' or undefined, every row passes (the activity rail
   * shows the full stream). */
  surface?: NotificationScope;
}

function passesSurfaceFilter(
  n: Notification,
  surface: NotificationScope | undefined,
): boolean {
  if (surface !== 'bell') return true;
  /* Default to 'conversation' for un-tagged legacy rows so they get
   * filtered out of the bell. */
  const cls: NotifyClass = n.notify_class ?? 'conversation';
  return BELL_NOTIFY_CLASSES.has(cls);
}

export function listNotifications(
  options: ListNotificationsOptions = {},
): Notification[] {
  const limit = options.limit ?? 200;
  if (!fs.existsSync(FILE)) return [];
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const map = new Map<string, Notification>();
  try {
    const lines = fs.readFileSync(FILE, 'utf-8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Notification | NotificationOp;
        if (isOp(parsed)) {
          const existing = map.get(parsed.id);
          if (existing) applyDismiss(existing, parsed.scope);
        } else {
          if (Date.parse(parsed.ts) < cutoff) continue;
          // Backfill: older records persisted dismissed:true without
          // dismissed_scopes; treat as dismissed in every scope so old
          // dismisses keep working after the schema change.
          if (!Array.isArray(parsed.dismissed_scopes)) {
            parsed.dismissed_scopes = parsed.dismissed ? [...ALL_SCOPES] : [];
          }
          parsed.dismissed = ALL_SCOPES.every((s) =>
            parsed.dismissed_scopes!.includes(s),
          );
          map.set(parsed.id, parsed);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return Array.from(map.values())
    .filter((n) => passesSurfaceFilter(n, options.surface))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, limit);
}

export function dismissNotification(
  id: string,
  scope?: NotificationScope | 'all',
): void {
  ensureDir(DASHBOARD_DIR);
  const op: NotificationOp = {
    op: 'dismiss',
    id,
    ts: new Date().toISOString(),
    ...(scope ? { scope } : {}),
  };
  fs.appendFileSync(FILE, JSON.stringify(op) + '\n', 'utf-8');
}

export function unreadCount(scope: NotificationScope = 'bell'): number {
  return listNotifications({ surface: scope }).filter(
    (n) => !(n.dismissed_scopes ?? []).includes(scope),
  ).length;
}
