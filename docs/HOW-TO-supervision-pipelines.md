# How-to: supervision pipelines

> Architectural deep dive for the four pipelines that landed on top of
> PROJECT-ANCHORS: event-driven supervision, smart compact, brainstorm
> threading (sibling index + Phase 2 preload + backfill), and the
> cross-session inject + bridge presence substrate they share.
>
> Last updated: 2026-05-12.

This doc is the canonical reference when you (or Lex) need to know
*where the wires are* and *what guarantees each layer makes*. The spec
docs under `docs/spec/` capture the design intent; this doc captures
what is actually wired in the daemon today.

---

## 1. Bridge presence + project anchor reconcile

Daemon-side files:

- `07-daemon/src/dashboard/bridge-presence.ts` (`reconcileBridgePresence`,
  `startBridgePresenceLoop`).
- `09-bridge/src/presence.ts` (`writePresenceFiles`,
  `buildPresencePayload`).
- `07-daemon/scripts/migrations/019-project-anchors.ts` (project_session
  + project_transcript_ref tables).

### Lifecycle per VS Code window

1. The bridge extension's tick loop (`09-bridge/src/extension.ts`)
   writes one presence file per workspace folder under
   `<dataRoot>/session-bridge/.bridge-presence/<workspace-key>.json`
   every 750ms. Payload: `{workspace, cwd, bridge_id, updated_at,
   cc_session_ids?}`.

2. The daemon's `startBridgePresenceLoop` runs `reconcileBridgePresence`
   on a timer (1s default, override via `DEVNEURAL_BRIDGE_TIMEOUT_MS`).
   For every presence file whose mtime is inside
   `BRIDGE_TIMEOUT_MS` (30s default), it:
   - resolves the `project_session` anchor by cwd
     (`getProjectSessionByCwd`),
   - flips `status='live'`, stamps `current_bridge_id` (encoded as
     `<primary>|<count>` when multiple windows are bound),
     `current_session_id`, `last_seen_ms`,
   - if the resolved anchor just took on a CC session UUID, opens a
     row in `project_transcript_ref` (idempotent on UNIQUE
     `cc_session_id`); if the prior CC session id was different,
     closes that ref's `closed_ms` first.

3. Every anchor that was live but received no fresh presence file on
   this tick flips back to dormant: `current_*` cleared,
   `closeProjectTranscriptRef` called if `current_session_id` was set,
   `last_seen_ms` stamped.

### Why this matters

`project_transcript_ref` is the table every higher-level pipeline
joins on. If presence reconcile drops a ref insert, the dashboard
anchor tile feed, `/lex/voice-snapshot open_projects`, the sibling
index preloader, and the event-driven supervision listener all stop
seeing the project. The 0119710 fix wires the insert/close pair into
the live/dormant transitions; verify the daemon test
`07-daemon/tests/bridge-presence.test.ts` stays green when touching
either side.

---

## 2. Cross-session injection pipeline

Daemon-side files:

- `07-daemon/src/lex/cross-session-inject.ts` (`crossSessionInject`,
  `issueToken`, `verifyToken`, allowlist + HMAC + audit).
- `07-daemon/scripts/migrations/017-cross-session-injection-log.sql`
  (audit table).
- `07-daemon/src/dashboard/routes.ts` POST
  `/lex/inject-cross-session` and POST `/auth/cross-session-token`.

### Flow

1. Caller (Lex, the event-supervisor listener, a Stream Deck button)
   POSTs `/auth/cross-session-token` with `target_session` to mint a
   short-lived HMAC token (valid 2 minutes, current and previous
   UNIX-minute slots).
2. Caller POSTs `/lex/inject-cross-session` with
   `{target_session, token, text, caller_label?, commit?}`.
3. `crossSessionInject`:
   - verifies the HMAC, audits `rejected_auth` on miss,
   - checks the allowlist (`DEVNEURAL_CROSS_SESSION_ALLOWLIST` env;
     empty allowlist = unrestricted), audits `rejected_allowlist` on
     miss,
   - if a daemon-owned PTY for `target_session` is live, calls
     `ptyInject` directly,
   - otherwise falls back to `queueSessionPrompt` /
     `queueSessionSuggestion` (the bridge marker pipeline).
4. Every attempt writes one row to `cross_session_injection_log`
   with the verdict (`accepted | rejected_auth | rejected_allowlist
   | rejected_pty`).

### `caller_label` conventions

| Path | `caller_label` |
|---|---|
| Lex's own tool calls | `lex-voice` or `lex-text` |
| Event-driven supervision listener | `event-supervisor` |
| Smart compact fire path | `smart-compact:<reason>` |
| Manual dashboard inject | `dashboard:<surface>` |

Audit grep on `caller_label` is the single fastest way to confirm
which surface is actually firing in a soak.

---

## 3. Smart compact orchestration

Daemon-side files:

- `07-daemon/src/lex/smart-compact.ts` (pure helpers).
- `07-daemon/src/dashboard/smart-compact-routes.ts` (routes + binder).
- `07-daemon/scripts/migrations/021-smart-compact-log.sql`.

### Trigger logic

`evaluateTrigger({ctxPct, threshold, bandHalf, hardCeiling,
stopWindowMs, now, lastCommitMs, lastToolMs, phase})` returns
`{action, reason}`:

| ctxPct | hasStop | result |
|---|---|---|
| `>= hardCeiling` (default 90) | any | `fire` / `hard-ceiling` |
| `< threshold - bandHalf` (default 55) | any | `wait` / `below-window` |
| `in [threshold-bandHalf, threshold+bandHalf]` (default 55–65) | true | `fire` / `window-open` |
| same window | false | `wait` / `no-stop` |
| `> threshold + bandHalf, < hardCeiling` | n/a | `wrap` / `forced-no-stop` |

Stop point = recent commit (`<=30s`), idle tool (`>30s` since last
tool_use), or `phase ∈ {idle, permission}`.

### Fire path

- `action='fire'`: daemon injects `/clear` then the resume summary
  built by `assembleSummary` (durable sources: spec/TODO/git/jsonl
  tail/audit findings).
- `action='wrap'`: daemon injects the canonical
  `WRAP_AND_COMMIT_PROMPT` so the worker manufactures a stop, then
  Lex re-evaluates.
- Both go through the existing `ptyInject` against the anchor's
  `current_pty_id`.

### Shadow mode

`isShadow(db, anchorId, n)` gates the first **N=3** attempts per
anchor (override via `DEVNEURAL_SMART_COMPACT_SHADOW_N`). Shadow
rows write to `smart_compact_log` with `action='shadow'` and never
touch the PTY. After N successful shadow rows, the next fire is live.
`force=true` on the route bypasses the gate.

### Audit columns

`smart_compact_log` rows carry `caller`, `reason`, `action` (fire /
wrap / shadow / noop), `pre_ctx_pct`, `post_ctx_pct`,
`summary_preview` (first 280 chars). Dashboard panel surface is at
`GET /lex/smart-compact/recent`.

---

## 4. Event-driven supervision

Daemon-side files:

- `07-daemon/src/dashboard/worker-event-router.ts` (gate, detectors,
  payload, Lex target resolver, route decision).
- `07-daemon/src/dashboard/worker-event-detect.ts` (parseJsonlTail,
  deriveEvents, per-anchor `AnchorTailState`).
- `07-daemon/src/dashboard/worker-event-killswitch.ts`
  (`applyKillSwitch`, `bindKillSwitch`).
- `07-daemon/src/dashboard/worker-event-listener.ts` (chokidar
  binding, `processChange`).
- `07-daemon/scripts/migrations/022-supervision-mode.sql`
  (project_session.supervision_mode column).

### Loop

```
jsonl write
  -> chokidar (add | change)
  -> processChange(file, deps)
       -> ccSessionId = basename(file, '.jsonl')
       -> anchor      = getProjectSession(getProjectTranscriptRefByCc.anchor_id)
       -> skip if supervision_mode !== 'event'
       -> tail        = read(file, last 32KB)
       -> skip if sig(tail.size:mtime) === prev.lastTailSig
       -> parsed      = parseJsonlTail(tail)
       -> {events, nextState} = deriveEvents(parsed, prev, anchor, now, sig)
       -> for ev of events:
            routeWorkerEvent(ev, {gate, resolveTarget, inject, anchor, onKillSwitch})
              -> gate.evaluate(ev, now)
                   -> 'debounce' -> drop
                   -> 'kill-switch' -> onKillSwitch(anchor_id), drop
                   -> 'accept' -> inject(resolveTarget(), buildSupervisorPrompt(ev))
                                  -> crossSessionInject with caller_label='event-supervisor'
```

### Watched events

| Event | Detection | Fire rule |
|---|---|---|
| `permission_denied` | jsonl tail matches `/Permission to use \w+ has been denied/` | per-type debounce 30s |
| `test_failure` | jsonl tail mentions vitest/jest/npm test/etc AND exit-code-nonzero | same |
| `commit` | jsonl tail has `git commit ... N files changed` OR `[branch hash]` | same |
| `idle` | `now - lastAssistantMs > 10min` AND no pending tool | same |
| `pending_prompt` | (reserved; not yet wired through deriveEvents) | n/a |
| `bridge_disconnect` | (reserved; not yet wired) | n/a |

### Debounce + kill-switch

`WorkerEventGate` (in `worker-event-router.ts`) tracks per-anchor
state with three knobs:

- `perTypeMinGapMs` (default 5 min): same event type cannot re-fire
  inside this window for the same anchor.
- `perAnchorHourlyCap` (default 12): hard cap on total events to
  Lex per anchor per hour.
- `killSwitchPerTenMinutes` (default 20): more than this in 10 min
  trips the kill-switch.

When the kill-switch trips, `bindKillSwitch(db)` (from
`worker-event-killswitch.ts`):

1. Sets `supervision_mode='polling'` on the offending
   `project_session` row.
2. Emits a `severity='warn'` notification (source=`supervision`,
   link=`/projects`). The existing `maybePushNotification` path
   pushes via VAPID + falls back to BurntToast.
3. Records the trip in an `alreadyTripped` Set so a second trip
   inside the same daemon process is mode-flip-only (no second
   notification).

### Lex target session resolver

`resolveLexTargetSession(db, opts?)` (60s cached) returns the
`cc_session_id` of the open `lex_transcript_ref` under the most
recently created live `lex_session`. The router treats this as the
inject target; if it returns null, the event is dropped with
`outcome='no-target'`.

### Toggling supervision

`PATCH /projects/:id` accepts `{supervision_mode: 'polling' | 'event'
| 'off'}`. Dashboard wrapper:
`patchProjectAnchor(anchorId, {supervision_mode})` in
`08-dashboard/lib/daemon-client.ts`. The project tile menu UI for
the toggle is still pending; HTTP + client are ready.

---

## 5. Brainstorm threading (sibling index)

Daemon-side files:

- `07-daemon/src/lex/sibling-index.ts` (`buildSiblingIndex`).
- `07-daemon/src/lex/sibling-distillation-preload.ts`
  (`preloadSiblingDistillations`).
- `07-daemon/src/lex/sibling-distillation-backfill.ts`
  (`runDistillationBackfill`).

### Phase 1: index injection at spawn / reopen

`buildSiblingIndex({db, label, excludeId?, limit?,
distillationWords?})`:

- Match key: lowercase, whitespace-trimmed `user_label`.
- Excludes `excludeId` (the just-created session) so a fresh anchor
  never lists itself.
- Result is a markdown block:
  ```
  # Sibling sessions (same label "<label>")

  Prior brainstorms the user named the same way. Reference if context
  demands; do not re-read the transcripts unless asked.

  - <id8> "<label>" started <ISO> [— <distillation up to N words>]
  ```
- Empty / null label returns the empty string — singletons skip
  the block entirely; the caller can concat unconditionally.
- Distillation tail is pulled from `brainstorm_sessions.last_summary`
  (truncated at `distillationWords`, default 10).

### Phase 2 part 1: preloader

`preloadSiblingDistillations({db, label, excludeId?, generator,
limit?, now?})`:

- Generator is an injected
  `(row: BrainstormSessionRow) => Promise<string | null>` so the LLM
  provider stays a swap-in.
- Picks the top **N=2** most-recent same-label siblings missing
  `last_summary`, calls the generator, persists via
  `updateBrainstorm` with `last_summary_ms` stamped at `now()`.
- Null generator output or thrown error is treated as a clean skip;
  the row's `last_summary` stays null and the sibling-index line
  simply omits the tail.
- Returns `{preloaded, skipped, already_present}` for logging.

### Phase 2 part 2: backfill job

`runDistillationBackfill({db, generator, limit?, label?, excludeId?,
now?})`:

- Default cap: **N=5** rows per run so a cold start cannot melt the
  LLM provider. `BACKFILL_DEFAULT_LIMIT = 5` exported.
- Selection: every brainstorm_session with null/empty
  `last_summary`, most-recent first, optionally filtered by label,
  optionally excluding a specific id.
- `hit_cap` in the result tells the caller whether to schedule
  another tick.
- The job itself is pure; the scheduler that periodically calls it
  is still pending (no LLM provider wired into the daemon-side
  scheduler yet; manual / HTTP triggers possible).

### Why two phases

The preloader keeps spawn latency low: only the top 2 entries hit
the LLM, and the sibling-index render falls back to id + label +
started for anything missing. The backfill sweeps the rest at its
own cadence, bounded by the cap so the user can hammer "new
brainstorm" without queuing 50 LLM calls.

---

## 6. Verifying the wires in a soak

| Symptom | First check |
|---|---|
| Dashboard anchor tile disappears | `reconcileBridgePresence` log + `project_transcript_ref` rows |
| `/lex/voice-snapshot open_projects` empty | bridge-presence dir `<dataRoot>/session-bridge/.bridge-presence/` mtimes |
| Lex never sees worker events | `supervision_mode='event'` on the anchor + chokidar `[worker-event]` log lines |
| Event mode silent on a known stall | `WorkerEventGate` per-type gap, or kill-switch trip in `notifications.jsonl` source=`supervision` |
| Smart compact never fires | `smart_compact_log` action column: all `shadow` rows = still in shadow N |
| Sibling block missing on spawn | the new session has no `user_label` set (singleton path) or no other same-label rows yet |
| Sibling line missing distillation | `brainstorm_sessions.last_summary IS NULL` → run backfill |

`cross_session_injection_log` grouped by `caller_label` is the
single highest-signal table for "who injected what when" across
every pipeline above.
