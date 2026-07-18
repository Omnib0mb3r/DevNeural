# How-to: dashboard UX surfaces

> User-facing reference for the dashboard panels that landed alongside
> the supervision-pipeline work: the global panic button, the Lex
> transcript history panel, the Past Sessions compact pattern, and the
> shared collapse-toggle helper they all use.
>
> Last updated: 2026-05-12.

---

## 1. Global panic button

Spec: `docs/spec/PANIC-BUTTON.md`. Implementation:
- `08-dashboard/components/PanicButton.tsx`
- `08-dashboard/components/PanicAuditPanel.tsx`
- `07-daemon/src/dashboard/panic-routes.ts`
- `07-daemon/src/dashboard/panic-target.ts`
- `07-daemon/scripts/migrations/020-panic-log.sql`

### What it does

One click sends `\x1b\x1b` (double-ESC, the Claude Code interrupt
sequence) to the single resolved live worker anchor. Same effect as
pressing ESC twice at the worker keyboard.

### Where it lives

Top bar, immediately right of the voice stop control. The visible
`<kbd>` badge that used to show `Ctrl+Alt+.` next to the button was
removed; the keybind still fires, but it is now surfaced only through
the button tooltip. That tooltip carries the canonical description:
"Send double-ESC to active worker (interrupt current tool /
generation). Keybind: Ctrl+Alt+."

### States

- **idle** — red outline, ready to fire.
- **firing** — solid red pulse, 250ms, disabled.
- **cooldown** — 1s lockout after fire to prevent double-tap. No
  confirmation dialog by design; the cooldown handles fat-finger.

### Targeting

Resolution runs at click time (not at render) via
`resolvePanicTarget(db)`:

1. Exactly one live anchor → that one.
2. Multiple live, one in phase `thinking` / `tool` → that one.
3. Tie between busy anchors → most recent by `last_seen_ms`.
4. No live anchors → button disabled, tooltip says
   `No live worker to interrupt`.

### Keybind

Global `Ctrl+Alt+.` (period). Listener ignores keydown events whose
target is an `<input>`, `<textarea>`, `<select>`, or
`contentEditable` element so typing a period does not fire the
button. `caller='dashboard-keybind'` on the audit row distinguishes
keybind presses from button presses.

### Audit

Every fire writes one row to `panic_log` regardless of outcome
(`accepted | pty_not_found | no_target`). The dashboard surfaces
the last 20 rows on `/system` via `PanicAuditPanel`, refresh every
10s. The Lex voice command `Lex emergency stop` fires through the
same `firePanic` path with `caller='lex-voice'`. The bare phrase
"emergency stop" no longer matches (2026-05-14); every Lex voice
command requires the explicit `Lex` prefix so meeting chatter
cannot false-fire the panic path.

### Lex voice-command suite

The hard-coded, `Lex`-prefixed keyword grammar was torn out
2026-07-15 (voice top layer v2).
`07-daemon/src/voice/lex-voice-commands.ts` now matches only the
panic phrase (`matchPanicCommand`, "Lex emergency stop"); every other
voice control is interpreted by the voice top layer rather than
pattern-matched. The top layer emits trailing `CONTROL:` directive
lines as part of its natural turn (`mute` / `unmute` / `standby` /
`listen` / `disable` / `end_session` / `stop_speaking` /
`interrupt_work`); those lines are stripped from speech and dispatched
server-side through `dispatchVoiceCommand` in
`07-daemon/src/voice/lex-voice-ws.ts`.

So there is no fixed phrase list to memorise any more: you ask Lex to
stop talking, stand by, wrap up the session, and so on in natural
language, and the top layer maps the intent to the right control
effect. Only "Lex emergency stop" stays a mechanical keyword, checked
before anything else so the operator can always halt the system even
when the top layer is down.

### Per-project interrupt

`POST /projects/:id/interrupt` is the anchor-pinned variant. Same
audit row shape; `target_anchor_id` is the route param. Used by
Lex when she wants to interrupt a specific worker without going
through the global resolver.

---

## 2. Lex transcript history panel

Implementation:
- `08-dashboard/components/TranscriptHistory.tsx` (pure render
  component).
- `08-dashboard/components/LexTranscriptHistoryPanel.tsx` (VoiceCtx
  wrapper).
- `08-dashboard/lib/transcript-collapse.ts`
  (`createCollapseStore`).

### What it does

Renders the trailing N turns of the live voice conversation (default
10) instead of the previous single-turn lastUser/lastReply rendering
that disappeared the moment a new transcript landed. Mounted on
`/lex` between TerminalMirror and LexArtifactsPanel.

### Thinking placeholder

When the voice client status is `'thinking'` (i.e. the user just
finished an utterance and Lex is generating), the panel renders a
muted `lex: Lex is thinking…` line below the existing turns. The
placeholder disappears as soon as the next `assistant-text` lands.

### Collapse toggle

Top-right `collapse` / `expand` button. Collapsed state hides the
body entirely; aria-expanded flips. Persists to localStorage under
the key `devneural.lex.transcript.collapsed` via
`createCollapseStore`. Default expanded on first load. Mount-time
read picks up the persisted value.

### Cap + scrollback

The component caps render at `maxTurns` (default 10, configurable).
The in-memory turn buffer in `VoiceClient` is capped at 50 entries;
the daemon's jsonl is the canonical full transcript and the
`/lex/sessions/:id` + `POST /lex/chunk-search` paths cover full
history retrieval.

---

## 3. Past Sessions compact (LexSessionList)

Implementation:
- `08-dashboard/components/LexSessionList.tsx`.
- Shared collapse helper:
  `08-dashboard/lib/transcript-collapse.ts`
  (`createCollapseStore`).

### What it does

Replaces the older max-h-72 (288px) list with a max-h-56 (224px,
roughly 3.5 rows) body that uses internal scroll for the rest. The
panel sits between the page header and TerminalMirror.

### Collapse-to-strip

Header gets a `collapse` / `expand` button on the right next to
`new brainstorm`. Collapsed state replaces the body with a thin
strip showing `<N> sessions, <K> live` so the panel never disappears
entirely. Default expanded on first load.

Persistence key: `devneural.lex.past-sessions.collapsed`
(`PAST_SESSIONS_COLLAPSE_KEY` export). Distinct from the transcript
collapse key so the two panels can collapse independently.

---

## 4. Collapse-toggle shared pattern

`08-dashboard/lib/transcript-collapse.ts` exports
`createCollapseStore(key: string)` returning
`{read, write, key}`:

- `read(storage?)` returns the persisted boolean (default false /
  expanded). SSR-safe: bails when `window` is undefined.
- `write(collapsed, storage?)` writes `'1'` on collapse and clears
  the key on expand.

Backwards-compat exports (`readCollapsedState`,
`writeCollapsedState`, `COLLAPSED_STORAGE_KEY`) are kept as the
transcript-key default so the TranscriptHistory component is
unchanged.

Use this whenever you add a new collapse-able panel. Pick a key
under the `devneural.<surface>.<panel>.collapsed` namespace so the
namespace stays auditable from devtools `localStorage`.

---

## 5. Responsive collapse (top bar)

`08-dashboard/components/TopBar.tsx`:
- Each TABS link wraps the label in
  `<span className="hidden sm:inline">` so below 640px only the
  lucide icon renders. `aria-label` and `title` on the Link still
  carry the human-readable name for screen readers and tooltips.
- Search placeholder span gains `min-w-0 truncate`, leading Search
  icon gains `shrink-0`, so the wide button cannot push past its
  parent's `max-w-2xl` container even with longer placeholder copy.

Verify on a 375px viewport (iPhone width preset in Chrome
DevTools); the panic button + voice pill + auth pill + status pill
all stay on the bar with the nav icons compressed to a horizontally
scrollable row.

---

## 6. Mic-gate indicator during TTS playback

`08-dashboard/components/VoiceClient.tsx`:

While the daemon is streaming TTS the pill keeps the `Mic` lucide
icon and shows a "mic paused" overlay; it does NOT swap to `MicOff`
and there is no "muted (tts)" label. Labelling the gate "muted (tts)"
while Lex was audibly talking was an inverted-label bug, and keeping
`Mic` reflects that the always-on wake-word recognizer is still
listening. Only an explicit user mute flips the icon to `MicOff`.
The hard mic gate (driven by `tts-start` / `tts-end` WS events) still
fully pauses silero VAD + the parallel capture rig + the push-to-talk
path so the speaker's own audio cannot loop back through whisper as
the user's "next utterance".

Tooltip on the pill while gated:
`Mic paused while Lex is speaking. Resumes automatically when TTS
finishes.`
