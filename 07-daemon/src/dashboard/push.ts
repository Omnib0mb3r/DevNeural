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

function loadOrCreateVapid(): VapidKeys {
  if (cached) return cached;
  ensureDir(DASHBOARD_DIR);
  if (fs.existsSync(VAPID_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8')) as VapidKeys;
      if (parsed.publicKey && parsed.privateKey) {
        cached = parsed;
        webpush.setVapidDetails(parsed.subject, parsed.publicKey, parsed.privateKey);
        return parsed;
      }
    } catch {
      /* fall through to regenerate */
    }
  }
  const generated = webpush.generateVAPIDKeys();
  const subject =
    process.env.DEVNEURAL_VAPID_SUBJECT ?? 'mailto:noreply@devneural.local';
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

export async function sendPushToAll(
  payload: { title: string; body?: string; url?: string; id?: string; tag?: string },
): Promise<{ delivered: number; pruned: number }> {
  loadOrCreateVapid();
  const subs = listSubscriptions();
  if (subs.length === 0) return { delivered: 0, pruned: 0 };
  let delivered = 0;
  let pruned = 0;
  await Promise.all(
    subs.map(async (s) => {
      const ws: WebPushSubscription = { endpoint: s.endpoint, keys: s.keys };
      try {
        await webpush.sendNotification(ws, JSON.stringify(payload));
        delivered++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // gone — drop the subscription
          removeSubscription(s.id);
          pruned++;
        }
      }
    }),
  );
  return { delivered, pruned };
}

/** Hook into emitNotification — only warn + alert push by default.
 * OP-2 native toast fallback: when web push delivers zero pushes
 * (no subscriptions, all stale, push server unreachable), spawn a
 * Windows toast via BurntToast. The notification is already in
 * notifications.jsonl regardless, so the dashboard surface is
 * unaffected; the toast is the user-eyeball signal that survives
 * a missing PWA install. */
export async function maybePushNotification(n: Notification): Promise<void> {
  if (n.severity === 'info') return;
  const result = await sendPushToAll({
    title: n.title,
    ...(n.body ? { body: n.body } : {}),
    ...(n.link ? { url: n.link } : {}),
    id: n.id,
    tag: n.source,
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
