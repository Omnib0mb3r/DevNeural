/**
 * DevNeural Heartbeat Watcher (Option A - same-host Windows Service).
 *
 * Listens on HTTP port 3748 for POST /heartbeat from the daemon.
 * Tracks the last-beat timestamp in memory and on disk.
 * When no beat arrives within WATCHER_TIMEOUT_SECONDS, fires:
 *   1. A Windows toast notification via BurntToast (PowerShell).
 *   2. An optional webhook POST to WATCHER_ALERT_URL.
 *
 * Install as a Windows Service via nssm (see README.md).
 *
 * Environment variables:
 *   WATCHER_PORT              (default: 3748)
 *   WATCHER_TIMEOUT_SECONDS   (default: 600 = 10 minutes)
 *   WATCHER_ALERT_URL         optional webhook URL for missed-beat alerts
 *   WATCHER_ALERT_COOLDOWN_S  seconds between repeated alerts (default: 900)
 *   WATCHER_LOG_FILE          log file path (default: ./data/watcher.log)
 *   WATCHER_STATE_FILE        state file path (default: ./data/last-beat.json)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.WATCHER_PORT ?? 3748);
const TIMEOUT_S = Number(process.env.WATCHER_TIMEOUT_SECONDS ?? 600);
const ALERT_URL = process.env.WATCHER_ALERT_URL ?? '';
const ALERT_COOLDOWN_S = Number(process.env.WATCHER_ALERT_COOLDOWN_S ?? 900);
const LOG_FILE = process.env.WATCHER_LOG_FILE
  ?? path.join(__dirname, '..', 'data', 'watcher.log');
const STATE_FILE = process.env.WATCHER_STATE_FILE
  ?? path.join(__dirname, '..', 'data', 'last-beat.json');

/* Ensure data dir exists. */
try {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch {
  /* already exists */
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* log write failed; keep going */
  }
}

/* Persistent state: last beat timestamp and last alert timestamp. */
let lastBeatMs = Date.now(); /* optimistic: assume daemon just started */
let lastAlertMs = 0;

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    if (typeof state.last_beat_ms === 'number') {
      lastBeatMs = state.last_beat_ms;
    }
    if (typeof state.last_alert_ms === 'number') {
      lastAlertMs = state.last_alert_ms;
    }
  } catch {
    /* no state file yet; defaults fine */
  }
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        last_beat_ms: lastBeatMs,
        last_alert_ms: lastAlertMs,
        updated_at: new Date().toISOString(),
      }),
      'utf8',
    );
  } catch {
    /* not fatal */
  }
}

/* Fire a Windows toast via BurntToast PowerShell module. */
function fireToast(title, body) {
  const ps = `
    Import-Module BurntToast -ErrorAction SilentlyContinue;
    New-BurntToastNotification -Text '${title.replace(/'/g, "''")}','${body.replace(/'/g, "''")}' -AppLogo $null;
  `;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
    { windowsHide: true, timeout: 10_000 },
    (err) => {
      if (err) {
        log(`[toast] failed: ${err.message}`);
      } else {
        log('[toast] fired');
      }
    },
  );
}

/* POST to the configured alert webhook. Fire-and-forget. */
function fireWebhook(message) {
  if (!ALERT_URL) return;
  try {
    const url = new URL(ALERT_URL);
    const body = JSON.stringify({
      event: 'heartbeat_missed',
      message,
      last_beat_ms: lastBeatMs,
      last_beat_iso: new Date(lastBeatMs).toISOString(),
      silence_s: Math.round((Date.now() - lastBeatMs) / 1000),
      watcher_host: require('os').hostname(),
    });
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const proto = url.protocol === 'https:' ? require('https') : http;
    const req = proto.request(opts, (res) => {
      log(`[webhook] responded ${res.statusCode}`);
    });
    req.on('error', (err) => log(`[webhook] error: ${err.message}`));
    req.setTimeout(8_000, () => req.destroy());
    req.write(body);
    req.end();
  } catch (err) {
    log(`[webhook] send failed: ${err.message}`);
  }
}

function fireAlert() {
  const nowMs = Date.now();
  const silenceS = Math.round((nowMs - lastBeatMs) / 1000);
  const cooldownMs = ALERT_COOLDOWN_S * 1000;
  if (nowMs - lastAlertMs < cooldownMs) {
    /* Cooldown still active; don't spam. */
    return;
  }
  lastAlertMs = nowMs;
  saveState();
  const title = 'DevNeural daemon heartbeat missed';
  const body = `No beat for ${silenceS}s (threshold: ${TIMEOUT_S}s). Daemon may be down.`;
  log(`[alert] ${body}`);
  fireToast(title, body);
  fireWebhook(body);
}

/* Check liveness every 30s. */
function checkLiveness() {
  const silenceMs = Date.now() - lastBeatMs;
  if (silenceMs > TIMEOUT_S * 1000) {
    fireAlert();
  }
}

/* HTTP server: accepts POST /heartbeat, GET /status. */
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/heartbeat') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        /* ignore malformed JSON */
      }
      lastBeatMs = Date.now();
      saveState();
      log(`[beat] ts=${payload.ts ?? 'unknown'} pid=${payload.daemon_pid ?? '?'} ver=${payload.daemon_version ?? '?'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, watcher_ts: new Date().toISOString() }));
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    const silenceMs = Date.now() - lastBeatMs;
    const healthy = silenceMs <= TIMEOUT_S * 1000;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      healthy,
      last_beat_iso: new Date(lastBeatMs).toISOString(),
      silence_s: Math.round(silenceMs / 1000),
      timeout_s: TIMEOUT_S,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

loadState();
server.listen(PORT, '127.0.0.1', () => {
  log(`[watcher] listening on 127.0.0.1:${PORT} (timeout=${TIMEOUT_S}s cooldown=${ALERT_COOLDOWN_S}s)`);
});
server.on('error', (err) => {
  log(`[watcher] server error: ${err.message}`);
  process.exit(1);
});

const livenessInterval = setInterval(checkLiveness, 30_000);
livenessInterval.unref();

process.on('SIGINT', () => { log('[watcher] shutting down (SIGINT)'); process.exit(0); });
process.on('SIGTERM', () => { log('[watcher] shutting down (SIGTERM)'); process.exit(0); });
