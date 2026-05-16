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

### Runtime kill-switch (three-state)

The host-wide kill-switch is a three-state runtime toggle backed
by `runtime_config.smart_compact_mode`:

- `off` — `fireSmartCompact` short-circuits to `action='noop'` with
  no row inserted and no PTY inject. `force=true` does NOT override
  off; off is supposed to be inert. Use this to drop the system
  cold when a runaway evaluator is spamming `/clear`.
- `shadow` (default) — every fire becomes a shadow row regardless
  of per-anchor isShadow gate. Inject never runs. Equivalent to
  the old `DEVNEURAL_SMART_COMPACT_ENABLED` unset/false behavior.
- `live` — per-anchor `isShadow(db, anchorId)` decides; otherwise
  inject + fire/wrap row. Equivalent to the old env=true behavior.

Resolution order in `smartCompactMode(db)`:

1. `runtime_config.smart_compact_mode`
2. `DEVNEURAL_SMART_COMPACT_ENABLED` env (truthy → live, falsey →
   off, `shadow` → shadow)
3. default = `shadow`

The dashboard exposes the toggle at `/system` via
`SmartCompactPanel` (three-segment selector mirroring
`LexColdStartPreloadPanel`). Reads + writes go through
`GET/POST /lex/smart-compact/toggle`; the flip takes effect on the
next fire request without a daemon restart.

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

Sibling source is the current anchor's prior `lex_transcript_refs`
(every prior CC binding under the same anchor), ordered by
`ordering` DESC, excluding the current ref. Each ref is a distinct
Lex restart against the same brainstorm row. Label-grouped lookup
across other `brainstorm_sessions` rows is retained as a fallback
only when the anchor has zero prior refs.

`buildSiblingIndex({db, label, anchorId, currentCcSessionId,
excludeId?, refLimit?, limit?, distillationWords?, turnSnippetChars?,
pairsPerRef?, readTranscript?, now?})`:

- When `anchorId` is supplied, primary path pulls prior refs via
  `listLexTranscriptRefs(anchorId)`, sorts by `ordering` DESC,
  drops the current `currentCcSessionId`, and takes the top
  `refLimit` (default 2).
- For each prior ref the helper reads `transcript_path` via the
  injected `readTranscript` (filesystem by default), extracts the
  last `pairsPerRef * 2` user/assistant messages with
  `extractLastTurnPairs` (skips tool_use / tool_result / compact
  summaries), and renders:
  ```
  # Prior Lex sessions on this anchor

  Earlier CC sessions bound to this same Lex brainstorm. Reference
  if context demands; do not re-read the transcripts unless asked.

  ## Prior session N (ago: 4h ago)
  Summary: <brainstorm.last_summary or "(no distillation yet)">
  Last 5 turns:
  - user: ...
  - assistant: ...
  ```
- When `anchorId` is absent OR the anchor has 0 prior refs, the
  helper falls back to the legacy label-match block (id8 + label +
  ISO + truncated distillation) so a brand-new anchor still gets
  some context surfaced.
- `now` injection keeps "ago" rendering deterministic in tests.

### Phase 2 part 1: preloader

`preloadSiblingDistillations({db, anchorId, excludeRefId?,
generator, limit?, now?})`:

- Generator is an injected
  `(ref: LexTranscriptRef) => Promise<string | null>` so the LLM
  provider stays a swap-in (claude-haiku-4-5 by default once wired).
- Picks the top **N=2** most-recent prior refs under the anchor
  missing a distillation, reads the ref's jsonl tail (cap input at
  12000 chars), calls the generator, persists the distillation
  against the ref row with `last_summary_ms` stamped at `now()`.
- Null generator output or thrown error is treated as a clean skip;
  the ref's distillation stays null and the sibling-index line
  simply omits the tail.
- Each preload payload also carries the last 5 user/assistant
  message pairs from the ref's jsonl so the next Lex spawn sees
  fresh verbatim context, not just a summary.
- Returns `{preloaded, skipped, already_present}` for logging.

### Phase 2 part 2: backfill job

`runDistillationBackfill({db, generator, limit?, anchorId?,
excludeRefId?, now?})`:

- Default cap: **N=5** refs per run so a cold start cannot melt the
  LLM provider. `BACKFILL_DEFAULT_LIMIT = 5` exported.
- Selection: every prior `lex_transcript_refs` row with null/empty
  distillation, most-recent first, optionally filtered to a single
  anchor, optionally excluding a specific ref.
- `hit_cap` in the result tells the caller whether to schedule
  another tick.
- The job itself is pure; the LLM provider is supplied via the
  injected generator. `createLlmDistillationGenerator` routes through
  the local-only ollama provider via the new `distillation` LlmRole
  (BF-4: anthropic is hard-blocked for brainstorm content).
- **Scheduler is now bound at daemon startup**
  (`startDistillationBackfillScheduler` in
  `07-daemon/src/lex/distillation-scheduler.ts`). First fire after a
  30s grace period (avoids blocking startup on the ollama warm-up),
  then every 10 minutes via `setInterval`. Tunable via env:
  `DEVNEURAL_DISTILL_SCHEDULER_INTERVAL_MS`,
  `DEVNEURAL_DISTILL_SCHEDULER_FIRST_FIRE_MS`. If the provider is
  unconfigured or set to anthropic the scheduler logs once on boot
  and returns a no-op handle so the logs stay quiet.

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
| Sibling block missing on spawn | the anchor has zero prior `lex_transcript_refs` (genuine first session) — fallback label-match path also empty |
| Sibling line missing distillation | the prior ref has null distillation → run backfill (LLM wiring + ANTHROPIC_API_KEY required) |

`cross_session_injection_log` grouped by `caller_label` is the
single highest-signal table for "who injected what when" across
every pipeline above.

---

## 7. Auto-advance supervisor (Lex-cron handoff)

Phase 4 of the autonomous supervisor pipeline. The daemon-side loop
replaces Lex's heuristic auto-advance for the clean-idle-done case.
Lex keeps every judgment branch (worker rebuts, options, blocked,
needs_input, needs_attention); the daemon only takes over the
straightforward path where the worker said `status=done` and asked
for nothing in return.

### What the loop does

Every tick (default 30s, env
`DEVNEURAL_AUTO_ADVANCE_INTERVAL_MS`), for each project anchor
with `supervision_mode='event'` and runtime
`auto_advance_mode` in `(shadow, live)`:

1. Read the worker's CC jsonl tail. Pull the last assistant
   message.
2. Quiescence gate: no trailing `tool_use`, PTY idle for at
   least 5s, the SAME `assistant turn uuid` observed across
   two consecutive ticks.
3. Footer gate: `parseWorkerStatusFooter` on the terminal
   text. Hard require `status=done`, `needs_input=false`,
   `needs_attention=false`. Absence of a footer is a no-go.
4. Idempotency gate: refuse to fire twice on the same
   assistant turn uuid (per-anchor in-memory state). Double-
   fire raises a `voice-alert` of kind `double-fire`.
5. Atomic claim: `claimBacklogItem` against `lex_backlog_items`
   keyed on `(anchor_id, turn_uuid)`.
6. Lease bump: `bumpAutoAdvanceLease` increments
   `project_session.auto_advance_epoch` so a second
   supervisor process is fenced.
7. Mode branch:
   - `shadow` → write `auto_advance_log` row with
     `decision='shadow'` + `would_inject_preview`. No inject.
   - `live` → write `auto_advance_log` row with
     `decision='accepted'` AND invoke `crossSessionInject`
     with `caller_label='auto-supervisor'`,
     `target_session=anchor.current_session_id`, `commit=true`.

Every gate failure lands in `auto_advance_log` with
`decision='skip'` + a typed `reason` (`awaiting-stability`,
`trailing-tool-use`, `pty-still-active`, `no-footer`,
`status-needs_input`, `status-blocked`, `status-in_progress`,
`needs-attention`, `already-advanced-this-turn`,
`backlog-empty`, `claim-already-claimed`, `lease-contention`,
`no-current-session`, `live-injector-not-wired`). Reviewer
queries:

```sql
SELECT decision, reason, COUNT(*) FROM auto_advance_log
  WHERE created_at > datetime('now','-1 hour')
  GROUP BY decision, reason
  ORDER BY 3 DESC;
```

### Runtime kill-switch (three-state)

`runtime_config.auto_advance_mode`:

- `off` (default) — loop dormant. No quiescence eval, no
  audit rows.
- `shadow` — loop runs, every clean-idle-done turn writes a
  `decision='shadow'` row + `would_inject_preview`. No
  `crossSessionInject`.
- `live` — loop runs and fires `crossSessionInject` on every
  clean-idle-done turn.

Flip via the dashboard `/system` page (AutoAdvanceModePanel
mirrors SmartCompactPanel) or via curl:

```bash
curl -X POST http://localhost:3747/lex/auto-advance/toggle \
  -H 'content-type: application/json' \
  -d '{"mode":"live","updated_by":"operator"}'
```

Flip takes effect on the next tick; no daemon restart.

### Audit endpoint

`GET /lex/auto-advance/recent?limit=50&decision=&mode=&anchor_id=`
returns the most recent log rows for the dashboard panel and for
post-mortem review.

### Handoff from the Lex-side cron

Lex used to run its own heuristic auto-advance: every N seconds
it polled `/sessions/:id` for the worker session, applied
prose-shaped checks ("looks done?", "looks idle?", "no question
marks?"), and fired a manual cross-session inject. This was the
Codex review's core complaint: prose heuristics are not a control
plane.

After Phase 1 (worker footer protocol + parser) and Phase 2
(sqlite backlog with atomic claim), Phase 3 built the daemon-side
loop and ran it in shadow for at least one productive session.
With shadow output reviewed and the audit log clean, Phase 4
explicitly stops the Lex-side cron for the DevNeural anchor:

> **Action: Lex stops the Claude-side supervision cron for
> brainstorm `4bbafb48-bbfd-47e6-b076-e1a58a334303`.** No more
> heuristic polling on the worker session id
> `f98dd3b5-d41a-4a13-87f2-992421b6d527`; the daemon's
> auto-advance loop is the canonical owner of the
> clean-idle-done path. Lex still handles every judgment
> branch (worker rebuts, options, disagreement,
> `status=needs_input`, `needs_attention=true`) because the
> daemon loop hard-gates on `status=done AND
> needs_input=false AND needs_attention=false`.

How to drop a Lex cron: from the brainstorm Lex prompt,
acknowledge the handoff and stop scheduling the heuristic poll.
On future sessions the worker handoff doc (the SessionStart
additionalContext block built by `src/lex/worker-handoff.ts`)
already carries the `WORKER_STATUS_FOOTER_TEMPLATE` reminder so
the worker emits the machine-parsable footer on every terminal
turn. No code changes needed Lex-side; the cron is decided by
Lex's own routine, which is now told via this doc that the
daemon owns the path.

### Voice-alert escalations

The supervisor surfaces four escalations through a
`VoiceAlertSink` dep:

- `claim-ok-inject-failed` — backlog claim succeeded but the
  subsequent `crossSessionInject` returned non-ok. Backlog row
  is left in-flight; operator must investigate.
- `accepted-no-user-turn` — inject accepted but no new user
  turn arrived within the timeout window. Reserved for the
  follow-up phase that wires turn-detection.
- `double-fire` — supervisor tried to advance the same
  assistant turn uuid twice. The idempotency gate blocked it;
  alert exists so operators see the race.
- `kill-switch` — operator-driven hard stop. Implemented in the
  next phase.

Phase 4 leaves the sink unwired in production (the daemon
bootstrap does not pass `voiceAlert`); a future phase plugs it
into `logVoice` + push notifications.

### Symptom-first debug table

| Symptom | First check |
|---|---|
| Panel reads `mode=off` after flipping | `getRuntimeConfig('auto_advance_mode')` vs env override |
| Loop runs but never advances | `auto_advance_log` decision=skip rows + reason column |
| Live mode silent on a known idle worker | confirm footer landed via `parseWorkerStatusFooter` + check `awaiting-stability` reason (needs two consecutive ticks) |
| Same item fires twice | `claimed_turn_uuid` in `lex_backlog_items` + `already-advanced-this-turn` log |
| Concurrent daemons fight | `auto_advance_epoch` mismatches; `lease-contention` rows |
