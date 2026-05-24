/**
 * Web push delivery via VAPID.
 *
 * VAPID keypair is generated once on first daemon launch and persisted at
 * dashboard/vapid.json. The public key is exposed to the dashboard so the
 * service worker can call PushManager.subscribe() with it. Subscriptions
 * are persisted at dashboard/push-subscriptions.jsonl (append-only).
 *
 * sendPush() is wired into emitNotification() so warn+alert severities
 * trigger a push to every subscriber. info notifications do not push.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import webpush, { type PushSubscription as WebPushSubscription } from 'web-push';
import { DATA_ROOT, ensureDir } from '../paths.js';
import type { Notification } from './notifications.js';

const DASHBOARD_DIR = path.posix.join(DATA_ROOT, 'dashboard');
const VAPID_FILE = path.posix.join(DASHBOARD_DIR, 'vapid.json');
const SUBS_FILE = path.posix.join(DASHBOARD_DIR, 'push-subscriptions.jsonl');

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

interface StoredSubscription {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  created_at: string;
  user_agent?: string;
}

interface SubscriptionOp {
  op: 'unsubscribe';
  id: string;
  ts: string;
}

let cached: VapidKeys | null = null;

/* Legacy default that pre-dates 2026-05-14. Apple's APNs JWT
 * validator rejects mailto subjects whose domain part is a non-
 * routable TLD (`.local`, `.invalid`, `.localhost`, `.example`)
 * with `403 BadJwtToken`, which means every push to an iPhone PWA
 * fails silently while desktop FCM continues to deliver. The
 * migration block in loadOrCreateVapid upgrades any persisted file
 * carrying this exact value to DEFAULT_VAPID_SUBJECT below. Keep
 * the constant for reference + future diagnostics; do NOT use it
 * for any new write. */
export const LEGACY_BAD_VAPID_SUBJECT = 'mailto:noreply@devneural.local';

/* Public-TLD mailto Apple accepts. The .app TLD is real, so the
 * subject parses as a deliverable email per RFC 6068 and Apple's
 * stricter VAPID JWT audit passes. The address itself does not
 * need to be reachable; APNs only checks the form. Override via
 * the DEVNEURAL_VAPID_SUBJECT env if operators want a contact
 * address they actually monitor. */
export const DEFAULT_VAPID_SUBJECT = 'mailto:noreply@devneural.app';

/* Validate a subject the way Apple does so the migration block +
 * fresh-key path agree on what's safe. Rules pulled from the
 * empirical 2026-05-14 isolation probe (C:/tmp/probe-ios-push*.mjs
 * captured Apple returning BadJwtToken for .local but 201 Created
 * for .app / .com / https). */
const NON_ROUTABLE_TLDS = new Set([
  'local',
  'localhost',
  'invalid',
  'example',
  'test',
]);
export function isSafeVapidSubject(subject: string | undefined | null): boolean {
  if (!subject || typeof subject !== 'string') return false;
  const trimmed = subject.trim();
  if (trimmed.startsWith('mailto:')) {
    const addr = trimmed.slice('mailto:'.length);
    const at = addr.indexOf('@');
    if (at < 1 || at === addr.length - 1) return false;
    const domain = addr.slice(at + 1).toLowerCase();
    if (!domain.includes('.')) return false;
    const tld = domain.split('.').pop() ?? '';
    if (NON_ROUTABLE_TLDS.has(tld)) return false;
    return true;
  }
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    try {
      const u = new URL(trimmed);
      if (NON_ROUTABLE_TLDS.has(u.hostname.split('.').pop() ?? '')) {
        return false;
      }
      return Boolean(u.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

function resolveSafeSubject(persisted: string | undefined): string {
  const fromEnv = process.env.DEVNEURAL_VAPID_SUBJECT;
  if (isSafeVapidSubject(fromEnv)) return fromEnv!;
  if (isSafeVapidSubject(persisted)) return persisted!;
  return DEFAULT_VAPID_SUBJECT;
}

function loadOrCreateVapid(): VapidKeys {
  if (cached) return cached;
  ensureDir(DASHBOARD_DIR);
  if (fs.existsSync(VAPID_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8')) as VapidKeys;
      if (parsed.publicKey && parsed.privateKey) {
        const safe = resolveSafeSubject(parsed.subject);
        if (safe !== parsed.subject) {
          /* Migrate the file in place: keep the keys (rotating
           * would invalidate every active subscription), only
           * swap the bad subject. Apple-side iOS PWAs that have
           * been silently failing on the legacy .local subject
           * start delivering on the very next push attempt. */
          console.log(
            `[push] migrating vapid subject ${JSON.stringify(parsed.subject)} -> ${JSON.stringify(safe)} (Apple rejects non-routable TLDs)`,
          );
          parsed.subject = safe;
          fs.writeFileSync(
            VAPID_FILE,
            JSON.stringify(parsed, null, 2),
            'utf-8',
          );
        }
        cached = parsed;
        webpush.setVapidDetails(parsed.subject, parsed.publicKey, parsed.privateKey);
        return parsed;
      }
    } catch {
      /* fall through to regenerate */
    }
  }
  const generated = webpush.generateVAPIDKeys();
  const subject = resolveSafeSubject(undefined);
  const fresh: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject,
  };
  fs.writeFileSync(VAPID_FILE, JSON.stringify(fresh, null, 2), 'utf-8');
  webpush.setVapidDetails(fresh.subject, fresh.publicKey, fresh.privateKey);
  cached = fresh;
  return fresh;
}

export function vapidPublicKey(): string {
  return loadOrCreateVapid().publicKey;
}

function isOp(value: unknown): value is SubscriptionOp {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { op?: string }).op === 'unsubscribe',
  );
}

export function listSubscriptions(): StoredSubscription[] {
  if (!fs.existsSync(SUBS_FILE)) return [];
  const map = new Map<string, StoredSubscription>();
  const lines = fs.readFileSync(SUBS_FILE, 'utf-8').split('\n').filter((l) => l.trim());
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as StoredSubscription | SubscriptionOp;
      if (isOp(parsed)) {
        map.delete(parsed.id);
      } else {
        map.set(parsed.id, parsed);
      }
    } catch {
      continue;
    }
  }
  return Array.from(map.values());
}

export function saveSubscription(input: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  user_agent?: string;
}): StoredSubscription {
  ensureDir(DASHBOARD_DIR);
  const id = Buffer.from(input.endpoint).toString('base64url').slice(0, 32);
  const record: StoredSubscription = {
    id,
    endpoint: input.endpoint,
    keys: input.keys,
    created_at: new Date().toISOString(),
    ...(input.user_agent ? { user_agent: input.user_agent } : {}),
  };
  fs.appendFileSync(SUBS_FILE, JSON.stringify(record) + '\n', 'utf-8');
  return record;
}

export function removeSubscription(id: string): void {
  ensureDir(DASHBOARD_DIR);
  fs.appendFileSync(
    SUBS_FILE,
    JSON.stringify({ op: 'unsubscribe', id, ts: new Date().toISOString() }) + '\n',
    'utf-8',
  );
}

/* Per-push audit row. One log line per subscription per attempt
 * (req_id, endpoint host, payload bytes, push-service status,
 * outcome) so future iOS-style silent failures are diagnosable
 * from daemon.log without rebuilding an isolation probe. The full
 * endpoint includes a long opaque device token; we log host +
 * outcome only so the line is greppable but not log-spam. */
function logPushAttempt(input: {
  reqId: string;
  endpoint: string;
  bytes: number;
  status: number | null;
  outcome: string;
  ms: number;
  bodyPreview?: string;
}): void {
  let host = '?';
  try {
    host = new URL(input.endpoint).host;
  } catch {
    /* malformed endpoint; keep host=? */
  }
  const bodyTail = input.bodyPreview
    ? ` body=${JSON.stringify(input.bodyPreview.slice(0, 160))}`
    : '';
  console.log(
    `[push] req=${input.reqId} host=${host} bytes=${input.bytes} status=${
      input.status ?? '?'
    } outcome=${input.outcome} ms=${input.ms}${bodyTail}`,
  );
}

export async function sendPushToAll(
  payload: {
    title: string;
    body?: string;
    url?: string;
    id?: string;
    tag?: string;
    /** Service worker reads this to pick icon / sound / urgency.
     * Defaults to 'reminder' for back-compat with the existing
     * scheduled-reminder push path. */
    event_type?: 'reminder' | 'attention';
    /** Free-form metadata: brainstorm_id, turn_id, snippet. The SW
     * forwards these in notification.data so the click handler can
     * deep-link into the dashboard. */
    data?: Record<string, string | number | boolean | null>;
  },
): Promise<{ delivered: number; pruned: number }> {
  loadOrCreateVapid();
  const subs = listSubscriptions();
  if (subs.length === 0) return { delivered: 0, pruned: 0 };
  let delivered = 0;
  let pruned = 0;
  /* Shared correlation id across every fanout call for this
   * notification. Subscriptions log under the same req= prefix so
   * a single push event can be traced across all subscribers. */
  const reqId = randomReqId();
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body, 'utf-8');
  await Promise.all(
    subs.map(async (s) => {
      const ws: WebPushSubscription = { endpoint: s.endpoint, keys: s.keys };
      const start = Date.now();
      try {
        const result = await webpush.sendNotification(ws, body);
        delivered++;
        logPushAttempt({
          reqId,
          endpoint: s.endpoint,
          bytes,
          status: result?.statusCode ?? 201,
          outcome: 'delivered',
          ms: Date.now() - start,
        });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? null;
        const errBody = String((err as { body?: unknown }).body ?? '');
        let outcome: string;
        if (status === 404 || status === 410) {
          removeSubscription(s.id);
          pruned++;
          outcome = 'pruned-gone';
        } else if (status === 403) {
          /* 403 from a push service almost always means VAPID auth
           * was rejected (BadJwtToken on Apple, AuthenticationError
           * on FCM). Surface it loudly so the next operator sees
           * the cause without re-running the isolation probe. */
          outcome = 'rejected-vapid';
        } else {
          outcome = 'error';
        }
        logPushAttempt({
          reqId,
          endpoint: s.endpoint,
          bytes,
          status,
          outcome,
          ms: Date.now() - start,
          bodyPreview: errBody,
        });
      }
    }),
  );
  return { delivered, pruned };
}

function randomReqId(): string {
  /* Short opaque id so the audit log lines correlate without
   * pulling crypto.randomUUID into the hot path. */
  return Math.random().toString(36).slice(2, 10);
}

/** Hook into emitNotification - default mode is 'auto' (warn + alert
 * push, info skipped). 'force' overrides the severity gate so the
 * lex-attention pipeline can fire at info-level when it makes sense.
 * 'suppress' is short-circuited by the caller in notifications.ts so
 * this function never sees it.
 *
 * OP-2 native toast fallback: when web push delivers zero pushes
 * (no subscriptions, all stale, push server unreachable), spawn a
 * Windows toast via BurntToast. The notification is already in
 * notifications.jsonl regardless, so the dashboard surface is
 * unaffected; the toast is the user-eyeball signal that survives
 * a missing PWA install. */
export async function maybePushNotification(
  n: Notification,
  opts: { mode?: 'auto' | 'force' } = {},
): Promise<void> {
  const mode = opts.mode ?? 'auto';
  /* Fix 21 (2026-05-24): respect the Fix 9 notify_class taxonomy.
   *
   * Policy (operator, 2026-05-24): push + bell fire ONLY for
   *   - critical / action-required items (notify_class='followup')
   *   - end-of-session reports          (notify_class='report')
   *   - signals worth a phone buzz       (notify_class='signal' + severity>=warn)
   * Everything else (conversation, idle ticks, info-level signals)
   * stays silent.
   *
   * Mapping:
   *   conversation -> skip (activity-rail only, like the bell filter)
   *   report       -> push (end-of-session / handover artifact)
   *   followup     -> push (action-required, e.g. lex-attention)
   *   signal       -> severity gate; warn / alert push, info skip
   *
   * Legacy rows without notify_class default to 'conversation' so
   * an un-tagged emit cannot leak to phone push, matching the bell
   * filter's default (notifications.ts:passesSurfaceFilter line
   * 207). */
  const cls = n.notify_class ?? 'conversation';
  if (cls === 'conversation') return;
  if (cls === 'signal' && n.severity === 'info') return;
  /* report + followup always push (mode='force' or 'auto'). The
   * legacy severity-info gate only applies to 'signal' above, so
   * an info-level report (e.g. session-end summary) still ships. */
  if (mode === 'auto' && cls !== 'signal' && cls !== 'followup' && cls !== 'report') {
    /* Defensive default: an unknown class lands here only if a new
     * NotifyClass value is added without updating this gate.
     * Suppress rather than leak. */
    if (n.severity === 'info') return;
  }
  const result = await sendPushToAll({
    title: n.title,
    ...(n.body ? { body: n.body } : {}),
    ...(n.link ? { url: n.link } : {}),
    id: n.id,
    tag: n.source,
    ...(n.event_type ? { event_type: n.event_type } : {}),
    ...(n.push_data ? { data: n.push_data } : {}),
  });
  if (result.delivered === 0) {
    const { showToast } = await import('./toast-fallback.js');
    await showToast({
      title: n.title,
      ...(n.body ? { body: n.body } : {}),
      ...(n.link ? { url: n.link } : {}),
    });
  }
}
