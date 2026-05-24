# DevNeural Future Features

Forward-looking scope. Index of what's planned but not built (or only partly built). Each entry links to its spec doc when one exists, plus a one-line "why" so future-us knows whether the motivation still holds.

Last updated: 2026-05-13.

## Near term (next milestone)

### Event-driven supervision
- Spec: `docs/spec/EVENT-DRIVEN-SUPERVISION.md`
- Replaces the polling supervision cron with daemon-push events. Includes a per-anchor `supervision_mode` column (polling / event / off). `off` is the user's kill-switch for auto-supervision and auto-inject.
- Why: 2-min polling burns context unnecessarily on idle workers. Event-driven only wakes Lex on actual worker state changes.

### Smart-compact orchestration
- Spec: `docs/spec/SMART-COMPACT.md`
- Decision layer that compacts worker context preemptively before the model itself triggers compact. Shadow-mode lands first (log only), then UI selector switch, then live.
- Why: native compact loses too much; supervised compact preserves the active-work spine.

### Brainstorm threading Phase 3+
- Phase 1 (sibling index) and Phase 2 (preload + backfill) shipped. Future phases:
  - LLM provider wired into the backfill scheduler (module is currently pure with injected generator + clock; nothing actually runs).
  - Cross-thread retrieval: bounded targeted retrieval across a thread so per-turn cost stays constant regardless of thread length.
- Why: brainstorms are core artifact; arbitrary-length threads must stay cheap to load.

### Supervision tunables in settings UI
- All supervision rate limits and thresholds today are env-tunable or hard-coded; not in the dashboard. Surface in the settings page (likely a new `SupervisionSettingsPanel`):
  - WorkerEventGate per-anchor hourly cap (today ~20/10min)
  - Worker stall thresholds (`DEVNEURAL_STALL_TOOL_MS` default 5min, `DEVNEURAL_STALL_USER_MS` default 3min, stall cooldown)
  - Expectation supervisor tick interval (default 90s, new from PLAN-brainstorm-without-cc.md section L)
  - Auto-advance mode (off/shadow/live), Cold-start preload mode (off/shadow/live), Smart-compact mode (off/shadow/live) — toggles exist, just need to be on the settings page alongside everything else
- Write-through via existing `/runtime-config/:key`. Daemon reads runtime_config first, falls back to env, then defaults.
- Why: hard-coded limits are invisible; runtime control matters when supervision is misbehaving and a daemon restart isn't desired.

### DevNeural docs refresh
- Comprehensive punch list from the supervision memory:
  - Text-input mode TTS suppression rationale.
  - iOS PWA push end-to-end smoke recipe.
  - Reminders -> web push wiring (ledger, dedupe on reminder_id, fallback toast, sweep -> firePushForReminder -> emitNotification).
  - Brainstorm threading Phase 1 + 2 internals.
  - Event-driven supervision architecture + kill-switch UX.
  - Smart-compact orchestration surface.
  - PANIC-BUTTON user-facing doc.
  - Brainstorm transcript history panel (last 10 turns + thinking placeholder + collapse).
  - Past Sessions compact pattern (capped height + collapse-to-strip + localStorage).
  - Cross-session injection pipeline detail.
  - Bridge presence + reconcile semantics.
  - Voice / TTS speed knob defaults + UUID pronunciation rule.
- Why: "where we were" should be recoverable from disk, not from session memory.

### Prune sweep
- Stale Playwright fixtures, dead screenshots, abandoned migration scripts, dead deps, orphaned test artifacts across DevNeural subdirs.
- Why: repo size + grep noise is creeping up.

## Phase 7 features

### Speaker diarization
- pyannote-based. Lex distinguishes primary speaker (user) from third-party voices (meetings, notes mode).
- Why: notes mode is meeting capture; brainstorm mode is single-speaker. Diarization separates the two cleanly without manual toggling.

### Lex fine-tune from brainstorm feedback corpus
- Brainstorm-folder feedback memories double as the labeled training corpus. Keep them concrete, self-contained, ready for supervised tuning.
- Why: Lex personality + supervision behavior shouldn't be reinvented in-prompt every session.

### Curator events in live_state
- Extend `UserPromptSubmit` live_state hook to inject Curator alert payloads, not just `open_reminders` count.
- Why: Curator findings should reach Lex without a poll.

## Long term

### Daemon split
- Spec: `docs/spec/FUTURE-DAEMON-SPLIT.md`
- Break the monolith daemon into focused services (supervision, transcript, brainstorm, push).
- Why: deferred until current daemon hits real scaling pain. Do not surface tonight.

### Database flexibility
- May swap SQLite for Postgres. Current SQLite is fine; keep schema and queries portable. Prefer `TEXT` UUID primary keys and ANSI SQL.
- Why: deferred; only matters if multi-host or concurrent-writer workload shows up.

### Unified Lex orchestration across N workers
- One Lex brain across multiple worker anchors. Per-anchor rolling summaries on demand, not N parallel agents.
- Why: scaling to many concurrent workers without context explosion.

### Auto-discover projects
- Filtered by project-marker files under `C:/dev/Projects` (or configured root). Create dormant anchors on daemon start; rescan every 5 min.
- Why: removes manual project-add step; matches the "everything Lex sees is discoverable from disk" model.

## How to use this doc

- Adding an idea: one section under the right time horizon, plus link to spec doc if one exists.
- Promoting an idea to a phase: move the entry into the active phase plan, leave a one-line pointer here that says "shipped in commit X, see Y".
- Killing an idea: delete it, don't leave tombstones.
