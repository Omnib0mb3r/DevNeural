# Spec: Event-driven Lex supervision of worker Claude Code sessions

**Created:** 2026-05-12 (brainstorm session "DevNeural Testing")
**Status:** Queued behind PROJECT-ANCHORS and SMART-COMPACT.
**Pattern source:** reuses cross-session inject (commit `8f68121`) and the existing chokidar transcript watcher in `07-daemon/src/dashboard/sessions.ts`.

---

## Goal

Replace polling-based Lex supervision (cron firing every N minutes) with daemon-driven push: when a worker hits a watched event, the daemon injects a synthetic prompt into Lex's brainstorm session so Lex reacts within seconds instead of waiting for the next cron tick.

---

## Why polling is the wrong floor

- 5–20 minute cron lag means a worker can sit denied or idle for most of a tick before Lex notices.
- Every cron fire reads the worker jsonl tail even when nothing changed: wasted tokens, wasted cache.
- User goes to bed assuming "Lex will catch the next stall," but the next stall might happen 30 seconds after the last poll and sit for 19 minutes.

The signals already exist on the daemon. Lex just can't see them without being woken.

---

## Watched events (initial set)

| Event | Detection source | Trigger condition |
|---|---|---|
| `worker.idle` | jsonl tail + stop_hook | last assistant message older than `IDLE_THRESHOLD_MS` (default 10 min) AND no pending tool_use |
| `worker.permission_denied` | jsonl tail | tool_result with `is_error:true` and content matching `/Permission to use \w+ has been denied/` |
| `worker.pending_prompt` | existing pending-prompt store | `pending_prompt` becomes non-null |
| `worker.test_failure` | jsonl tail | tool_result for vitest/npm test with non-zero exit |
| `worker.commit` | jsonl tail | Bash tool_result for `git commit` succeeds (informational; bundle multiple commits before firing) |
| `worker.bridge_disconnect` | bridge connection map | bridge for anchor flips disconnected |

Each event maps to a single payload shape: `{event, anchor_id, worker_session_id, timestamp, snippet}` where `snippet` is the last 2KB of jsonl context.

---

## Routing: daemon → Lex via cross-session inject

Reuse the existing pipeline. Daemon-side rule engine matches event → routing rule → injects to Lex's CC session UUID (resolved from the `lex_session` anchor flagged as the active brainstorm).

Inject text template:

```
[supervisor-event] worker=<anchor_label> event=<event_type> at <ts>

Snippet:
<last 2KB jsonl tail>

Decide: re-inject worker, widen permissions, escalate to user, or no-op.
```

Lex sees this as a normal user prompt. Existing system-prompt rules already say "permission denials are the supervision signal" → Lex acts.

---

## Rate limiting

- Per-event-type debounce (e.g. don't fire `worker.idle` more than once per 5 min for the same anchor).
- Global cap (e.g. 12 events/hour to Lex per anchor) so a misbehaving worker can't spam Lex's context.
- When debounced, daemon batches into a single `[supervisor-event-batch]` summary on the next allowed fire.

---

## Toggle

Per-anchor toggle on `project_session` row (`supervision_mode TEXT DEFAULT 'polling' CHECK(IN ('polling','event','off'))`). User can flip per project from the dashboard. Default is `polling` to keep the legacy behavior; `event` opts in.

---

## Migration plan

1. Add `supervision_mode` column to `project_session` (depends on PROJECT-ANCHORS shipping first).
2. Build daemon-side `worker-event-router.ts` that subscribes to chokidar transcript events + bridge state changes, evaluates rules, debounces, and posts to `/lex/inject-cross-session`.
3. Resolve "Lex's active CC session UUID" by querying the most recent live `lex_session` anchor with `mode='conversation'`. Cache for 60s.
4. Wire dashboard toggle in the Project tile menu.
5. Default tonight's cron supervision OFF for anchors with `supervision_mode='event'`.

---

## Already done — do NOT redo

- Cross-session inject pipeline (`POST /lex/inject-cross-session`, HMAC + allowlist + audit) shipped commit `8f68121`. Reuse, no new auth surface.
- Chokidar transcript watcher exists in `sessions.ts`. Extend, don't rewrite.
- `pending_prompt` store already captures Notification-driven waits.
- `lex_session` anchor model shipped commit `5af07d0`. Use to resolve Lex's target session UUID.

---

## Constraints / decisions

- One inject per event after debounce. Lex pulls full jsonl tail itself if the snippet isn't enough.
- Lex's session UUID is derived from the active brainstorm anchor, not configured. New brainstorm sessions automatically receive supervision events.
- Polling cron stays as the failsafe. Event mode supplements, doesn't replace, until a soak period proves reliability.
- Hard ceiling: if event router posts >20 events to Lex in 10 minutes, kill-switch flips supervision_mode to `polling` for the offending anchor and surfaces the runaway to user.
