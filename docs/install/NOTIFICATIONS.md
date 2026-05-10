# DevNeural notifications + native toast fallback (OP-2)

The daemon's notification surface has three layers:

1. **`notifications.jsonl`** — every notification appends here. The dashboard reads it for the system + activity rails.
2. **Web push** — when a notification has severity `warn` or `alert`, the daemon POSTs a web-push message to every subscribed PWA. The dashboard PWA shows the OS notification on each subscribed device.
3. **Native OS toast (fallback)** — when web push delivers zero pushes (no PWA subscribed, all subscriptions stale, push server unreachable), the daemon spawns a Windows toast via the BurntToast PowerShell module.

Layer 1 is always-on and has no dependencies. Layers 2 and 3 are best-effort.

## Web push

Already wired. `Get` keys via `GET /push/vapid-public-key`; subscribe via the dashboard's `PushSubscribeButton`. Subscriptions persist in `<DATA_ROOT>/dashboard/push-subscriptions.jsonl`.

To verify a push works: trigger a `warn` or `alert` severity notification (e.g. flip a wiki page to flagged-for-review) and watch your subscribed device.

## Native OS toast fallback

Triggered when `sendPushToAll` returns `delivered: 0`. The toast is rendered via `New-BurntToastNotification` and inherits Windows' notification center behaviour (Action Center history, focus assist rules, etc.).

### Install BurntToast

```powershell
Install-Module BurntToast -Scope CurrentUser
```

Verify:

```powershell
Get-Module -ListAvailable BurntToast | Select-Object Name, Version
```

### Test

```powershell
Import-Module BurntToast
New-BurntToastNotification -Text 'DevNeural smoke', 'If you can read this the fallback path is wired.'
```

### When BurntToast is missing

`showToast` logs once at the daemon level:

```
[toast] BurntToast module missing; install with: Install-Module BurntToast -Scope CurrentUser
```

Subsequent calls short-circuit until the daemon restarts. The notification is still in `notifications.jsonl` and the dashboard surface continues to display it.

### When PowerShell is missing

`showToast` logs once:

```
[toast] powershell unavailable: spawn powershell ENOENT
```

Same fallback behaviour: silent skip after the first log line. Useful for non-Windows hosts in dev / CI.

## Severity matrix

| Severity | notifications.jsonl | Web push | Native toast |
|---|---|---|---|
| `info` | yes | no | no |
| `warn` | yes | yes | only when push delivered=0 |
| `alert` | yes | yes | only when push delivered=0 |

## Disabling layers

There is no env var to disable web push or the toast fallback independently; both gate on whether their dependencies are present. To suppress all OS-level alerts, unsubscribe every PWA AND uninstall BurntToast (or run on a non-Windows host). The dashboard surface stays.
