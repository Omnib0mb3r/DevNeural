/**
 * External heartbeat poster (OP-1).
 *
 * The daemon POSTs a tiny JSON payload to DEVNEURAL_HEARTBEAT_URL
 * every DEVNEURAL_HEARTBEAT_INTERVAL_MS (default 60s). The watcher
 * service on the other end keeps its own last-beat timestamp; if
 * the daemon hangs or crashes, the watcher fires an alarm
 * (Pushover, ntfy, Telegram, phone shortcut). See
 * docs/install/HEARTBEAT.md for the watcher options.
 *
 * Every tick writes a row to heartbeat_log with status:
 *   'posted'        - HTTP attempted; awaiting ack
 *   'ack'           - watcher returned 2xx
 *   'no-ack'        - non-2xx OR network error
 *   'watcher-alarm' - written by the watcher itself when no beat
 *                     arrived within its timeout (not by this poster)
 *
 * Payload shape:
 *   { ts: ISO, daemon_pid: number, daemon_version: string }
 *
 * The poster is a no-op when DEVNEURAL_HEARTBEAT_URL is unset so
 * dev installs (no Tailscale, no watcher) skip it cleanly.
 */
import { randomUUID } from 'node:crypto';
import type { IndexDb } from '../store/index-db.js';

export interface HeartbeatPosterOptions {
  url?: string;            // DEVNEURAL_HEARTBEAT_URL
  intervalMs?: number;     // DEVNEURAL_HEARTBEAT_INTERVAL_MS, default 60_000
  daemonVersion?: string;  // logged for cross-host correlation
  log?: (msg: string) => void;
  /* fetch override for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

export interface HeartbeatPoster {
  start(db: IndexDb): void;
  stop(): void;
  /* Test/admin hook: fire one tick now and return its log status. */
  tickOnce(db: IndexDb): Promise<'posted-ok' | 'no-ack' | 'disabled'>;
}

export function createHeartbeatPoster(
  opts: HeartbeatPosterOptions = {},
): HeartbeatPoster {
  const url = opts.url ?? process.env.DEVNEURAL_HEARTBEAT_URL ?? '';
  const intervalMs =
    opts.intervalMs ??
    Number(process.env.DEVNEURAL_HEARTBEAT_INTERVAL_MS ?? 60_000);
  const daemonVersion = opts.daemonVersion ?? '0.1.0';
  const log = opts.log ?? (() => undefined);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  let timer: NodeJS.Timeout | null = null;

  async function postBeat(db: IndexDb): Promise<'posted-ok' | 'no-ack'> {
    if (!url) return 'no-ack'; // never reached; start() guards this
    const id = randomUUID();
    const payload = {
      ts: new Date().toISOString(),
      daemon_pid: process.pid,
      daemon_version: daemonVersion,
    };
    /* Insert the 'posted' row first so a network hang still leaves
     * a record in the log for forensics. */
    try {
      db.insertHeartbeatRow({
        id,
        daemon_pid: process.pid,
        daemon_version: daemonVersion,
        status: 'posted',
      });
    } catch (err) {
      log(`[heartbeat] log insert failed: ${(err as Error).message}`);
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        try {
          db.updateHeartbeatStatus(id, 'ack', `HTTP ${res.status}`);
        } catch {
          /* swallow */
        }
        return 'posted-ok';
      }
      try {
        db.updateHeartbeatStatus(id, 'no-ack', `HTTP ${res.status}`);
      } catch {
        /* swallow */
      }
      return 'no-ack';
    } catch (err) {
      try {
        db.updateHeartbeatStatus(id, 'no-ack', (err as Error).message);
      } catch {
        /* swallow */
      }
      return 'no-ack';
    }
  }

  return {
    start(db) {
      if (!url) {
        log('[heartbeat] DEVNEURAL_HEARTBEAT_URL unset; poster disabled');
        return;
      }
      if (timer) return;
      log(`[heartbeat] poster started: url=${url} interval=${intervalMs}ms`);
      void postBeat(db);
      timer = setInterval(() => void postBeat(db), intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async tickOnce(db) {
      if (!url) return 'disabled';
      return postBeat(db);
    },
  };
}
