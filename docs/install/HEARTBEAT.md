# DevNeural external heartbeat (OP-1)

The daemon POSTs a tiny payload to `DEVNEURAL_HEARTBEAT_URL` every `DEVNEURAL_HEARTBEAT_INTERVAL_MS` (default 60s). A separate watcher service tracks the last beat. When no beat lands within its timeout, the watcher fires an alarm.

This document covers the two acceptable watcher implementations and how to install each.

## Payload

`POST <url>` with JSON body:

```json
{
  "ts": "2026-05-10T19:39:46.367Z",
  "daemon_pid": 32252,
  "daemon_version": "0.1.0"
}
```

The watcher should respond `200 OK`. Anything else (or no response) is logged as `no-ack` in the daemon's `heartbeat_log` table.

## Disable

Unset `DEVNEURAL_HEARTBEAT_URL` (or set it to the empty string). The poster logs `[heartbeat] DEVNEURAL_HEARTBEAT_URL unset; poster disabled` once at boot and stays silent. Useful for dev installs.

## Option A: standalone Windows Service on the same host (recommended for Wave 2)

A tiny Node script listens on a different port (e.g. 3748) for `POST /heartbeat`. Keeps the last-beat timestamp in memory and on disk. If no beat in `WATCHER_TIMEOUT_SECONDS` (default 600), fires a Windows toast and posts to a configured webhook.

**Why on the same host:** still proves the daemon process is alive even if the local port is up.

**Why a separate process:** not implicated in a daemon hang.

Install steps (the watcher already exists at `07-daemon/heartbeat-watcher/`: `src/watcher.js`, `package.json`, `README.md`):

```powershell
cd 07-daemon\heartbeat-watcher
npm install
nssm install DevNeuralHeartbeatWatcher node "$pwd\src\watcher.js"
nssm start  DevNeuralHeartbeatWatcher
```

Then in the daemon environment:

```
DEVNEURAL_HEARTBEAT_URL=http://127.0.0.1:3748/heartbeat
```

## Option B: Tailscale-reachable phone shortcut

An iOS Shortcut listens on `https://<phone>.tail-XXXX.ts.net/heartbeat`. Phone shortcut maintains a local timer; if no beat in 10 minutes, fires a notification.

**Why phone:** independent of host entirely; if the host hangs the phone still alarms.

**Why this is harder:** shortcut reliability under iOS background restrictions.

Daemon environment:

```
DEVNEURAL_HEARTBEAT_URL=https://<phone>.tail-XXXX.ts.net/heartbeat
```

## Recommended

Option A in Wave 2 for simplicity. Add Option B in Wave 3 as a redundant alarm. The daemon poster is the same in either case; only `DEVNEURAL_HEARTBEAT_URL` differs.

## Forensics

`heartbeat_log` is the daemon-side authoritative log. Query for missed beats:

```sql
SELECT ts, status, detail
FROM heartbeat_log
WHERE status IN ('no-ack','watcher-alarm')
ORDER BY ts DESC
LIMIT 50;
```

A streak of `no-ack` rows during a known-good period is the watcher being unreachable, not the daemon being dead. A gap (no rows for an interval) is the daemon itself hung; rely on the watcher's alarm to catch this case.
