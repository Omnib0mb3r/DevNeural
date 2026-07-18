# How-to: voice / TTS knobs and the web-push channel

> Voice + TTS knobs, the text-input deliberately-bypasses-TTS rule,
> UUID pronunciation, and the reminders → web push pipeline with its
> 5-minute end-to-end smoke test.
>
> Last updated: 2026-05-12.

---

## 1. Voice / TTS speed knob

Implementation:
- `08-dashboard/components/VoiceClient.tsx`
  (`SPEED_STORAGE_KEY = "lex-tts-speed"`).
- Server-side persistence: `voice-preferences.json` under the data
  root.

### Defaults

- `SPEED_DEFAULT` is the Piper `length_scale` value used at first
  launch. Lower = faster.
- The slider in the voice settings panel writes through a debounced
  server-persist so dragging does not fire one POST per pixel.
- `localStorage` mirrors the value as an optimistic seed so the
  slider does not snap on remount; the daemon-stored value is the
  authority.

### Other knobs that share the persistence pattern

| Setting | Storage key | Server file |
|---|---|---|
| TTS length_scale / speed | `lex-tts-speed` | `voice-preferences.json` |
| Mic gain | `lex-mic-gain` | `voice-preferences.json` |
| Barge cooldown | `lex-barge-cooldown-ms` | `voice-preferences.json` |
| VAD sensitivity | `lex-vad-sensitivity` | `voice-preferences.json` |
| VAD redemption | `lex-vad-redemption-ms` | `voice-preferences.json` |

All of them follow the same shape: bounded constants
(`<NAME>_MIN`, `<NAME>_MAX`, `<NAME>_DEFAULT`), localStorage
optimistic seed, debounced server write, ref-mirror for the
non-React handlers.

---

## 2. Text-input deliberately suppresses TTS

This is a feature, not a bug.

### Where it lives

- `08-dashboard/app/lex/page.tsx` "Talk to Lex" textarea →
  `ptyInject(target, text, true)` (`lib/daemon-client.ts`).
- Voice path: utterance frames → WS `/voice/lex-ws` → daemon whisper
  → daemon inject → `assistant-text` event → Piper TTS frames
  back over the same WS.

### Why it stays

The text path bypasses the WS entirely, which means it bypasses
Piper. That is intentional: the user is typing because they do not
want audio. Removing the gap (e.g. by reading every assistant turn
aloud regardless of input modality) would constantly speak over the
user when they are in a quiet context — laptop in a meeting room,
phone on the desk while someone is talking, etc.

If you ever feel tempted to "fix" this by piping text-input
assistant-text through the voice WS, search this doc first.

---

## 3. UUID pronunciation rule

Lex's voice contract (see `07-daemon/src/lex/system-prompt.ts`)
says UUIDs are read character-by-character, not as syllabic
groups. `abcd1234-...` is "a b c d one two three four dash ...",
not "abcded one twenty-three four".

This matters because Lex regularly reads session ids out loud
during a brainstorm ("session a b c d eight, ready when you are").
Slurring the prefix sounds confident but the user can no longer
disambiguate against the tile list.

The rule lives in the system prompt only; there is no daemon-side
TTS preprocessor. If the model drifts (voice replay shows
syllabic reads), the fix is a few-shot example in the
`07-daemon/.../few-shot/<mode>.md` files, not a tokenizer rewrite.

---

## 4. Reminders → web push pipeline

Implementation:
- `07-daemon/src/dashboard/reminders.ts` (append-only jsonl store).
- `07-daemon/src/daemon.ts` reminder sweep (5-min interval).
- `07-daemon/src/dashboard/reminder-push.ts`
  (`firePushForReminder`, `loadPushedReminderIds`,
  `markReminderPushed`).
- `07-daemon/src/dashboard/notifications.ts`
  (`emitNotification`).
- `07-daemon/src/dashboard/push.ts`
  (`maybePushNotification`, VAPID, BurntToast fallback).

### Flow

```
daemon boot
  -> loadPushedReminderIds() seeds pushedIds set from
     <dataRoot>/dashboard/reminder-pushes.jsonl
  -> setInterval(sweepReminders, 5 min)
       -> for r of listReminders():
            skip if !r.due_at, r.completed_at, or due in future
            if !remindedIds.has(r.id):
              remindedIds.add(r.id)
              emitAwarenessEvent({kind:'reminder-due', ...})
            firePushForReminder(r, {pushedIds})
              -> skip if pushedIds.has(r.id) (cross-restart safe)
              -> markReminderPushed(r.id)   // append to ledger
              -> emitNotification({severity:'warn', source:'reminder',
                                    title, body, link:'/reminders'})
                   -> maybePushNotification(n)
                        -> sendPushToAll: VAPID push per subscription
                        -> if delivered === 0: showToast (BurntToast)
```

Two distinct dedupe paths:

| Set | Lifetime | What it protects |
|---|---|---|
| `remindedIds` | in-process (sweep loop) | awareness event channel — fires once per reminder per daemon process; resets on restart |
| `pushedIds` (+ ledger) | cross-restart | web push channel — a restart mid-sweep cannot re-buzz the user's phone |

Both are necessary: the awareness channel deliberately re-fires on
restart so Lex's snapshot stays accurate; the push channel must
not, because the user's phone does not care that the daemon
bounced.

### Subscription UI

Mounted in `08-dashboard/components/RemindersPanel.tsx` via
`<PushSubscribeButton />`. The button:

1. Calls `navigator.serviceWorker.register('/sw.js')`.
2. Calls `registration.pushManager.subscribe({userVisibleOnly:true,
   applicationServerKey: <VAPID public>})`.
3. POSTs the resulting subscription to
   `POST /push/subscribe`. The daemon stores it append-only in
   `<dataRoot>/dashboard/push-subscriptions.jsonl`.

iOS 16.4+ requires the dashboard to be installed as a home-screen
PWA *before* the Notification permission prompt can be shown. The
button surfaces a "Install to home screen first" hint when
`navigator.standalone` is false on iOS.

---

## 5. iOS PWA push end-to-end smoke test

5-minute verification path. Run after a daemon restart or a VAPID
key change.

1. **Add to home screen**: open the dashboard URL in Safari on the
   iPhone, hit Share → Add to Home Screen. Launch the icon. The
   URL bar should disappear (PWA mode).
2. **Subscribe**: on `/reminders`, tap the subscribe button. Accept
   the OS permission prompt.
3. **Verify on the daemon**:
   - `<dataRoot>/dashboard/push-subscriptions.jsonl` gained one
     row with the device's endpoint.
   - `GET /push/subscriptions` lists the new row.
4. **Fire a test reminder** that is already due:
   ```
   POST /reminders
   {"title":"smoke test","due_at":"<now-1min ISO>"}
   ```
   Wait for the next sweep tick (up to 5 min) OR call
   `POST /reminders/sweep` if wired.
5. **Confirm**:
   - Phone buzzes with the title.
   - `notifications.jsonl` gained a `source: "reminder"` row.
   - `reminder-pushes.jsonl` ledger gained a row for the reminder
     id.
6. **Confirm dedupe**: restart the daemon, wait one full sweep
   cycle, confirm the phone does **not** buzz a second time on
   the same reminder. Ledger should not have a second row for the
   same id.

If step 5 fails:

| Symptom | First check |
|---|---|
| No buzz, ledger updated | `sendPushToAll` log line; `delivered=0` means the iOS endpoint rejected the push — usually a stale subscription. Re-subscribe. |
| No buzz, no ledger | Sweep loop interval; daemon log for `[reminder sweep] failed`. |
| Buzz but missing title | `emitNotification` body shape; Piper-side payload encoding. |
| Buzz twice on restart | `loadPushedReminderIds` not reading the ledger; verify file path against `DEVNEURAL_DATA_ROOT`. |

---

## 6. Push as the supervision warn channel

Event-driven supervision's kill-switch and (future) smart-compact
trips funnel through the same `emitNotification` → push path, with
`source` distinguishing the surface:

| source | Fired by | Default severity |
|---|---|---|
| `reminder` | reminder sweep | `warn` |
| `supervision` | EDS kill-switch | `warn` |
| `audit-finding` (high) | lint / self-audit | `alert` |
| `ingest` | ingest pipeline failures | `warn` |

The shared push path means there is exactly one place to debug a
silent phone (`maybePushNotification`) regardless of which pipeline
should have been firing.
