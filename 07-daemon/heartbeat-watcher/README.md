# DevNeural Heartbeat Watcher

Standalone Node.js process that watches for heartbeats from the DevNeural daemon.
When no beat arrives within the timeout, it fires a Windows toast notification
and an optional webhook alert.

This implements Option A from `docs/install/HEARTBEAT.md` (same-host Windows Service).

## Requirements

- Node.js >= 18
- [nssm](https://nssm.cc) for Windows Service management
- [BurntToast PowerShell module](https://github.com/Windos/BurntToast) for toast notifications
  - Install: `Install-Module -Name BurntToast -Force -Scope CurrentUser`

## Install as Windows Service

Open PowerShell as Administrator in this directory:

```powershell
cd 07-daemon\heartbeat-watcher

# 1. Install the service
nssm install DevNeuralHeartbeatWatcher node "$pwd\src\watcher.js"

# 2. Set the working directory
nssm set DevNeuralHeartbeatWatcher AppDirectory "$pwd"

# 3. (Optional) Set environment variables
nssm set DevNeuralHeartbeatWatcher AppEnvironmentExtra `
  "WATCHER_TIMEOUT_SECONDS=600" `
  "WATCHER_ALERT_URL=https://your-webhook-url" `
  "WATCHER_LOG_FILE=$pwd\data\watcher.log"

# 4. Start the service
nssm start DevNeuralHeartbeatWatcher
```

Then configure the daemon to post to the watcher:

```
DEVNEURAL_HEARTBEAT_URL=http://127.0.0.1:3748/heartbeat
```

## Uninstall

```powershell
nssm stop DevNeuralHeartbeatWatcher
nssm remove DevNeuralHeartbeatWatcher confirm
```

## Smoke test

With the service running:

```powershell
cd 07-daemon\heartbeat-watcher
npm run smoke-test
```

Expected output includes `"healthy": true` and a `last_beat_iso` timestamp.

Manual beat test:

```powershell
Invoke-RestMethod -Method POST -Uri http://127.0.0.1:3748/heartbeat `
  -ContentType "application/json" `
  -Body '{"ts":"2026-05-11T00:00:00.000Z","daemon_pid":0,"daemon_version":"test"}'
```

Expected: `{"ok":true,"watcher_ts":"..."}`

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WATCHER_PORT` | 3748 | Port the watcher listens on |
| `WATCHER_TIMEOUT_SECONDS` | 600 | Seconds of silence before alert fires |
| `WATCHER_ALERT_URL` | (unset) | Webhook URL for missed-beat alerts |
| `WATCHER_ALERT_COOLDOWN_S` | 900 | Seconds between repeated alerts |
| `WATCHER_LOG_FILE` | `./data/watcher.log` | Log file path |
| `WATCHER_STATE_FILE` | `./data/last-beat.json` | Persistent state file |

## How it works

1. Daemon posts `POST /heartbeat` every `DEVNEURAL_HEARTBEAT_INTERVAL_MS` (default 60s).
2. Watcher records the timestamp in memory and in `data/last-beat.json`.
3. Every 30s the watcher checks if the last beat was within `WATCHER_TIMEOUT_SECONDS`.
4. If not: fires a Windows toast (via BurntToast) and the optional webhook.
5. Alerts are rate-limited by `WATCHER_ALERT_COOLDOWN_S` to avoid spam.

## Endpoints

- `POST /heartbeat` - accept a beat from the daemon
- `GET /status` - returns `{healthy, last_beat_iso, silence_s, timeout_s}`

## Forensics

Check `data/watcher.log` for the beat history. Each beat and alert is timestamped.
Cross-reference with `heartbeat_log` in the daemon's SQLite database for the
daemon-side view of the same events.
