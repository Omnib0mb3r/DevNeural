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
 *                  publishes for the user. NOT actionable, so it does
 *                  NOT hit the bell (BELL-ACTIONABLE-ONLY, 2026-07-18);
 *                  it stays on the activity rail / transcript.
 *   followup     - scheduled or condition-triggered item needing the
 *                  user's eye: a FIRED reminder or a Lex needs-you /
 *                  requires-user-input item. Hits the bell.
 *   signal       - automated supervision (worker stalled, daemon down,
 *                  push notifications, lint errors). Hits the bell ONLY
 *                  at 'alert' severity (an emergency); info/warn signals
 *                  live on the activity rail.
 *
 * BELL-ACTIONABLE-ONLY (2026-07-18 operator directive): the bell shows
 * ONLY things the user must act on - a fired reminder they set, a
 * needs-you/requires-user-input item, or an alert-severity emergency.
 * Reports, completions, autonomous decisions, telemetry, and routine
 * signals are NOT actionable: they go to the activity rail / transcript
 * and must not even APPEAR in the bell. So the bell allowlist keeps only
 * followup + signal (and signal only at alert, gated below). Un-tagged
 * legacy emits default to `conversation` and are dropped at the bell. */
export type NotifyClass = 'conversation' | 'report' | 'followup' | 'signal';
export const BELL_NOTIFY_CLASSES: ReadonlySet<NotifyClass> = new Set([
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
  /** Bell dedup + resolve key (SPEC-2026-07-18-bell-actionable-dedup).
   * Condition-based followups (repeated idle_prompt for one worker, a
   * "worker never received an inject" for one anchor) carry a stable
   * key: same key = same live condition. On the BELL surface these
   * collapse to one newest-wins row, expire after FOLLOWUP_TTL_MS, and
   * clear on resolveNotifications(key). A followup with NO dedup_key is
   * a user-set item (fired reminder, needs-you) and is never collapsed,
   * expired, or auto-resolved. The activity rail ignores the key. */
  dedup_key?: string;
  /** Bell only: how many raw followups collapsed into this row (>= 2).
   * Absent on un-collapsed rows. Computed at read time, never persisted. */
  dup_count?: number;
}

/** Bell TTL backstop (SPEC-2026-07-18-bell-actionable-dedup). A
 * condition-based followup (one carrying a dedup_key) older than this
 * is hidden from the BELL surface even if nothing explicitly resolved
 * it, so a stale idle/inject-fail pileup cannot linger. The activity
 * rail keeps it. User-set followups (no dedup_key) are never TTL-reaped. */
export const FOLLOWUP_TTL_MS = 6 * 60 * 60 * 1000; // 6h

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
  /** Bell dedup + resolve key (see Notification.dedup_key). Set it on a
   * repeating condition-based followup (idle_prompt, inject-fail) so the
   * bell collapses / expires / auto-clears it. Omit it on a user-set
   * followup that must stay distinct and never auto-clear. */
  dedup_key?: string;
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
    ...(input.dedup_key ? { dedup_key: input.dedup_key } : {}),
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

interface DismissOp {
  op: 'dismiss';
  id: string;
  ts: string;
  /** Omitted = legacy "dismiss everywhere"; one scope = surface-local. */
  scope?: NotificationScope | 'all';
}

/** Condition-resolved op (SPEC-2026-07-18-bell-actionable-dedup). Appended
 * by resolveNotifications when a followup's condition clears (a worker
 * went active again, an inject landed). Clears every followup carrying
 * this dedup_key that was emitted BEFORE this op (log order); a fresh
 * emit after it survives. Bell surface only. */
interface ResolveOp {
  op: 'resolve';
  dedup_key: string;
  ts: string;
}

type NotificationOp = DismissOp | ResolveOp;

function isDismissOp(value: unknown): value is DismissOp {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { op?: string }).op === 'dismiss',
  );
}

function isResolveOp(value: unknown): value is ResolveOp {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { op?: string }).op === 'resolve' &&
      typeof (value as { dedup_key?: unknown }).dedup_key === 'string',
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
  /** Clock override (ms since epoch) for the bell TTL backstop. Tests
   * pass a future time to prove a stale followup drops off the bell.
   * Defaults to Date.now(). */
  now?: number;
}

function passesSurfaceFilter(
  n: Notification,
  surface: NotificationScope | undefined,
): boolean {
  if (surface !== 'bell') return true;
  /* Default to 'conversation' for un-tagged legacy rows so they get
   * filtered out of the bell. */
  const cls: NotifyClass = n.notify_class ?? 'conversation';
  if (!BELL_NOTIFY_CLASSES.has(cls)) return false;
  /* 2026-07-16 operator directive: the bell pinned at 9+ because
   * automated 'signal' chatter (reinforcement hits, supervision
   * noise) counted as unread. 2026-07-18 BELL-ACTIONABLE-ONLY: reports
   * left the bell too. The bell is now reserved for ACTIONABLE items -
   * fired reminders + Lex needs-you (followup) and alert-severity
   * emergencies (signal@alert); info/warn signals and reports live on
   * the activity rail. */
  if (cls === 'signal' && n.severity !== 'alert') return false;
  return true;
}

/* Derive the collapse/TTL key for a bell followup. An explicit
 * dedup_key (set by every post-2026-07-18 emit) always wins. For the two
 * known condition-based followups that predate the key - the repeating
 * idle_prompt and the "never received an inject" - synthesize the same
 * shape from the durable anchor (push_data.anchor_id, else the link) so
 * the HISTORICAL pileup already on disk also collapses and ages off the
 * bell instead of sitting for 30 days. Returns undefined for a user-set
 * followup (a fired reminder, a Lex needs-you): those must stay distinct,
 * never collapse, never TTL-expire. */
function deriveBellDedupKey(n: Notification): string | undefined {
  if (n.dedup_key) return n.dedup_key;
  const cls = n.notify_class ?? 'conversation';
  const anchor = n.push_data?.anchor_id;
  /* Reference the DURABLE condition target: the anchor id when carried,
   * else the link with its per-turn fragment stripped so N turns of the
   * SAME brainstorm needing attention collapse to one row, not N. */
  const ref = (
    typeof anchor === 'string' && anchor ? anchor : (n.link ?? n.title)
  ).replace(/#.*$/, '');
  /* Signals are automated condition indicators (worker stalled, a
   * repeating distill error, daemon down). A live bell only needs ONE
   * row per (source, condition, worker) - the same stall re-flagged 191
   * times is one condition, not 191 emergencies. Collapse them per
   * source + title-family (trailing "(anchor)" / "#n" stripped) + anchor,
   * and let the TTL age a stale one off the bell. */
  if (cls === 'signal') {
    const fam = n.title
      .replace(/\s*\([0-9a-f-]{4,}\)\s*$/i, '')
      .replace(/\s*#?\d+\s*$/, '')
      .trim();
    return `sig:${n.source}:${fam}:${ref}`;
  }
  if (cls !== 'followup') return undefined;
  if (n.source === 'permission' && /^Claude waiting on you/.test(n.title)) {
    return `idle:${ref}`;
  }
  if (n.source === 'cross-inject' && /never received an inject/.test(n.title)) {
    return `inject-fail:${ref}`;
  }
  /* Lex attention (a needs-you / stall escalation) is condition-based:
   * one brainstorm re-flags every turn, so 68 turns pile as 68 rows.
   * Collapse per anchor (newest-wins) and let the TTL backstop age a
   * stale one off - the user sees ONE live "Lex needs you" per brainstorm,
   * carrying the latest message. */
  if (n.source === 'lex-attention') {
    return `attn:${ref}`;
  }
  /* A user-SET reminder (or any other followup) carries no derivable
   * condition key: it stays distinct, never collapses, never TTL-expires
   * - a fired reminder the user set is the actionable core of the bell. */
  return undefined;
}

/* Bell shaping (SPEC-2026-07-18-bell-actionable-dedup). Runs ONLY for
 * surface='bell'; the activity rail keeps every raw row. In order:
 *   1. resolve  - drop a dedup_key followup that has a resolve op later
 *                 in the log (its condition cleared); a fresh emit after
 *                 the resolve has no later resolve, so it survives.
 *   2. TTL      - drop a dedup_key followup older than FOLLOWUP_TTL_MS.
 *   3. collapse - group the survivors by dedup_key, keep the newest,
 *                 stamp dup_count (>= 2). Followups with NO dedup_key and
 *                 non-followup rows (signal@alert) pass through untouched.
 * order maps id -> log line index so "resolved before / emitted after"
 * and "newest wins" are decided by append order, robust to same-ms ts. */
function shapeBellFollowups(
  rows: Notification[],
  order: Map<string, number>,
  resolves: Map<string, number>,
  now: number,
): Notification[] {
  const passthrough: Notification[] = [];
  const groups = new Map<string, Notification[]>();
  for (const n of rows) {
    const key = deriveBellDedupKey(n);
    if (!key) {
      passthrough.push(n);
      continue;
    }
    const emittedAt = order.get(n.id) ?? 0;
    const resolvedAt = resolves.get(key);
    if (resolvedAt !== undefined && resolvedAt > emittedAt) continue; // resolved
    if (now - Date.parse(n.ts) > FOLLOWUP_TTL_MS) continue; // expired
    const g = groups.get(key);
    if (g) g.push(n);
    else groups.set(key, [n]);
  }
  const collapsed: Notification[] = [];
  for (const members of groups.values()) {
    members.sort(
      (a, b) =>
        Date.parse(b.ts) - Date.parse(a.ts) ||
        (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0),
    );
    const newest = members[0]!;
    collapsed.push(
      members.length > 1 ? { ...newest, dup_count: members.length } : newest,
    );
  }
  return [...passthrough, ...collapsed];
}

export function listNotifications(
  options: ListNotificationsOptions = {},
): Notification[] {
  const limit = options.limit ?? 200;
  if (!fs.existsSync(FILE)) return [];
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const map = new Map<string, Notification>();
  /* Append order per id + latest resolve line per dedup_key, so bell
   * shaping can decide resolved-before / emitted-after and newest-wins
   * without depending on identical millisecond timestamps. */
  const order = new Map<string, number>();
  const resolves = new Map<string, number>();
  let idx = 0;
  try {
    const lines = fs.readFileSync(FILE, 'utf-8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      idx += 1;
      try {
        const parsed = JSON.parse(line) as Notification | NotificationOp;
        if (isDismissOp(parsed)) {
          const existing = map.get(parsed.id);
          if (existing) applyDismiss(existing, parsed.scope);
        } else if (isResolveOp(parsed)) {
          resolves.set(parsed.dedup_key, idx);
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
          order.set(parsed.id, idx);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  let rows = Array.from(map.values()).filter((n) =>
    passesSurfaceFilter(n, options.surface),
  );
  if (options.surface === 'bell') {
    rows = shapeBellFollowups(
      rows,
      order,
      resolves,
      options.now ?? Date.now(),
    );
  }
  return rows
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

/** Clear every bell followup carrying `dedup_key` (the condition it
 * tracked has resolved: the worker went active again, the inject landed).
 * Appends a resolve op; followups emitted BEFORE it drop off the bell,
 * a fresh emit AFTER it survives (SPEC-2026-07-18-bell-actionable-dedup).
 * No-op semantics for the activity rail, which keeps the full history. */
export function resolveNotifications(dedup_key: string): void {
  if (!dedup_key) return;
  ensureDir(DASHBOARD_DIR);
  const op: ResolveOp = {
    op: 'resolve',
    dedup_key,
    ts: new Date().toISOString(),
  };
  fs.appendFileSync(FILE, JSON.stringify(op) + '\n', 'utf-8');
}

export function unreadCount(scope: NotificationScope = 'bell'): number {
  return listNotifications({ surface: scope }).filter(
    (n) => !(n.dismissed_scopes ?? []).includes(scope),
  ).length;
}

/** Clear-all for one surface (2026-07-16 operator ask). Appends one
 * dismiss op per undismissed row in the scope; the other surface's
 * visibility is untouched. Returns how many rows were cleared. */
export function dismissAllNotifications(scope: NotificationScope): number {
  const undismissed = listNotifications({ surface: scope }).filter(
    (n) => !(n.dismissed_scopes ?? []).includes(scope),
  );
  for (const n of undismissed) {
    dismissNotification(n.id, scope);
  }
  return undismissed.length;
}
