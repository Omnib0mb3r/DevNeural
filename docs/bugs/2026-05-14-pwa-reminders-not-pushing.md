# iOS PWA reminders not pushing through even with notifications enabled

**Reported:** 2026-05-14 (brainstorm session "DevNeural Testing")
**Severity:** medium
**Component:** reminder push pipeline / iOS PWA web-push subscription

## Symptom

User confirms reminders enabled on the iOS PWA, scheduled a reminder (3 currently open per live_state), but no push notification lands on the device. Dashboard shows reminders open, device stays silent.

## Reproduction

1. Install dashboard PWA on iPhone via Add to Home Screen.
2. Grant notification permission, confirm subscribe button shows enabled state.
3. Schedule a reminder for a near-future time (or already-due time).
4. Wait for reminder due time.
5. Observe: reminder fires server-side (visible in open_reminders count) but no push notification arrives on the device.

## Impact

- Breaks the core reminder use case for hands-busy / mobile operation.
- Same pipeline carries the new real-time Lex attention-needed notifications (commit f4cea84), so that path is likely also broken end-to-end on iOS PWA.
- Previously listed as "open verification item" in the overnight-supervision handover (memory project_active_supervision.md: "confirm a real iOS PWA actually receives the push end-to-end (code-complete != verified)"). Verification has now failed.

## Suspected location

End-to-end web-push pipeline on iOS PWA:

- `07-daemon/src/.../reminder-push.ts` module + daemon.ts call site (per overnight-supervision memory). Confirm push payload is actually being POSTed to the VAPID endpoint when a reminder fires.
- Subscription registration: confirm the PWA's service worker registered a PushSubscription, the subscription was stored server-side, and the daemon is dispatching to that exact endpoint.
- iOS Safari PWA quirks: notification permission must be granted AFTER Add to Home Screen, not before; subscription endpoints expire and need re-registration on PWA re-install.
- Service worker registration: confirm sw.js is registered, active, and handling `push` events. iOS PWAs silently drop push events if the SW is not fully active.
- VAPID keys: confirm public key on client matches private key on daemon; mismatched VAPID keys produce silent delivery failures.

## Status

Fixed (pending soak). Patched in the same commit as the per-push audit log line + safe-subject migration.

## Isolation step

Ran an out-of-band probe (`C:/tmp/probe-ios-push.mjs`) that re-used the daemon's `web-push` library + the persisted `dashboard/vapid.json` + the active iPhone subscription from `dashboard/push-subscriptions.jsonl`. The probe hand-crafted a single push directly against Apple's APNs endpoint, bypassing the reminder scheduler entirely. Result:

```
[probe] target_host=web.push.apple.com
[probe] vapid_subject=mailto:noreply@devneural.local
[probe] FAIL status=403 body={"reason":"BadJwtToken"}
```

Outcome **(c)** from the bug doc decision tree: push service returned 4xx — VAPID JWT rejected. f4cea84 is unrelated; the same break sits in the legacy default VAPID subject.

Confirmation probe with three known-good subjects all came back `201 Created`:

```
[probe] subject=https://github.com/Omnib0mb3r/DevNeural        OK status=201
[probe] subject=mailto:noreply@devneural.app                   OK status=201
[probe] subject=mailto:noreply@example.com                     OK status=201
```

## Root cause

`07-daemon/src/dashboard/push.ts:loadOrCreateVapid` baked `mailto:noreply@devneural.local` as the default VAPID subject. Apple's APNs JWT validator rejects mailto subjects whose domain part is a non-routable TLD (`.local`, `.invalid`, `.localhost`, `.example`, `.test`) with `403 BadJwtToken`. Every push to an iPhone PWA failed silently; desktop FCM accepted the same JWT and kept delivering, which is why the bug only showed up on the phone.

`DEVNEURAL_VAPID_SUBJECT` env override existed but was undocumented and unset on the user's box, so the bad default rode through to every push attempt.

## Fix

- New `DEFAULT_VAPID_SUBJECT = 'mailto:noreply@devneural.app'` (real TLD, Apple accepts).
- `isSafeVapidSubject` validates any candidate against a non-routable-TLD blocklist plus a structural check (mailto requires a non-empty local part + a real TLD; https/http require a parseable URL with a real-TLD host).
- `loadOrCreateVapid` migrates persisted vapid.json files in place: if the stored subject does not pass `isSafeVapidSubject`, the loader swaps it for the safe default and rewrites the file. Keys themselves are preserved so existing subscriptions stay valid.
- `LEGACY_BAD_VAPID_SUBJECT` exported for reference + future diagnostics. The env override (`DEVNEURAL_VAPID_SUBJECT`) is honoured first, then the persisted file, then the safe default.

Diagnosability:
- `sendPushToAll` now logs one `[push]` line per subscription per attempt: shared `req=<8-char id>` correlation, endpoint host, payload bytes, push-service status, outcome bucket (`delivered` / `pruned-gone` / `rejected-vapid` / `error`), elapsed ms, and a body preview when the push service rejected. A future iOS-style silent failure is now diagnosable from `daemon.log` alone without rebuilding the isolation probe.
- 403 responses bucket as `rejected-vapid` explicitly so an operator scanning logs sees the cause immediately.

## Verification

- `npm run build:check` (07-daemon) clean.
- `tests/push-vapid-subject.test.ts` (4 cases) pins the safety predicate; `tests/reminder-push.test.ts` (9) stays green; 13/13 across the push surface.
- Daemon rebuilt + restarted with the migrated vapid.json. Re-running the isolation probe with the new subject returned `201 Created` from Apple with an `apns-id` header.
- Real-hardware soak: wait for one of the three open reminders to fire (or schedule a near-future one), confirm the iPhone PWA rings.

## Open items

- Confirm the f4cea84 attention-needed push path also rings on the next compaction restart now that the underlying transport works. Both paths share `sendPushToAll`, so the fix covers them together.
- Soak window: at least one full reminder fire on real hardware before flipping to closed.
