# DevNeural Future Features

Forward-looking scope. Index of what's planned but not built (or only partly built). Each entry links to its spec doc when one exists, plus a one-line "why" so future-us knows whether the motivation still holds.

Last updated: 2026-07-18.

## Near term (next milestone)

### L2 mechanical confirm-gate before worker dispatch
- Today (`3b8ef37`, 2026-07-18) the "Lex (L2) confirms alignment with the operator before it prompts the worker (L3)" rule is PROMPT-enforced in the core Lex prompt (`system-prompt.ts` worker-inject section): state the plan out loud, get the go-ahead, only then `POST /lex/inject-cross-session`. Reliable (rides the existing voice conversation) but not mechanically guaranteed.
- Future: gate `/lex/inject-cross-session` itself on an operator voice-confirm. When Lex calls it, the daemon HOLDS the dispatch, speaks the plan/intent to the operator through Layer 1, waits for a voice yes/no, then releases (dispatch) or rejects (tell Lex to revise). Bulletproof: Lex literally cannot prompt the worker until the operator agrees. Mirrors the existing loose-ends gate pattern (`enforceLooseEndsGate` on `/projects/:id/start-claude`, returns 409 + report for a banner).
- Related: route the CC-native plan-approval prompt to Layer 1 so `--permission-mode plan` works headless on the mid. Blocker: the daemon only has a time-based boot-banner prompt hold (`isAwaitingSystemPrompt`), no ExitPlanMode/plan-approval detector; needs a real detector on the mid PTY output plus an approval inject. Until then `mid_permission_mode` defaults to `bypassPermissions` (headless `plan` mode stalls on the unanswered approval); flip live with `POST /runtime-config/mid_permission_mode {"value":"plan"}` once the routing exists.
- Why: mechanical enforcement guarantees the layer contract even if the model drifts from the prompt, and it makes true CC plan mode viable for the supervisor layer.

### Decouple voice `mode` from the WS/VAD lifecycle (voice 1006 debt)
- Today (warmup lock, 2026-07-18) `mode` is a dependency of the big WS/VAD effect in `08-dashboard/components/VoiceClient.tsx` (deps `[enabled, mode]`), so switching mode (conversation / notes / push-to-talk) tears down + rebuilds the whole engine INCLUDING the WS. Switching during warmup closed a still-CONNECTING socket, which the browser reports as close code 1006 -> reconnect loop (operator repro: "switched to push-to-talk during warm, errored out"). Guarded now: the mode buttons are disabled + dimmed and `changeMode` no-ops (info toast) while `warmingUp` (status connecting/warming). ACCEPTED as the fix per operator (gate-until-warm); this future item is the deeper cleanup, not a required follow-up.
- Future: a mode switch should NEVER touch the socket. Send `{t:'set-mode'}` on the LIVE WS (already sent by `changeMode`) and reconfigure ONLY the VAD in place (pause / rebuild the ORT VAD for PTT vs conversation), mirroring the SV-3 rebind-on-live-socket pattern (`46b9347`). Then drop `mode` from the effect deps so the engine builds once per enable. That removes the teardown/rebuild blip entirely and makes the warmup gate unnecessary.
- Why: mode is a VAD concern, not a transport concern; rebuilding the socket on every mode change is fragile (the 1006 was one symptom) and blips voice, the same failure class SV-1..3 fought for brainstorm switches.

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

### External CC session: dashboard surfacing + bridge-paste reliability
- Today's evidence (2026-06-04, Bridger session `9a96b53f`):
  1. `/sessions` puts externally-launched VS Code claude.exe sessions under `idle_projects`, not `open_projects`, even when bridge presence is fresh and `cc_session_ids` is latched. Classifier in `routes.ts` is keyed on daemon PTY ownership instead of bridge reachability, so `live_state` reports `open_projects=(none)` and Lex looks blind to a working worker.
  2. Cross-session inject via bridge-paste accepted by daemon (`transport=bridge`, queue file `<dataRoot>/session-bridge/<uuid>.in` written), but consumer side dead. Bridge VSIX writes presence ticks every 750ms (alive) yet the workspace offsets file under `.offsets/` is stale by days and does not reference the new UUID's queue file, so the paste never lands and the worker's jsonl never moves.
- Fixes:
  - Surface bridge-reachable sessions as `open_projects` with a transport flag (PTY vs bridge) so consumers know which features apply.
  - Harden bridge VSIX consumption polling so a long-lived window keeps picking up new per-UUID queue files (not just the set known at activation).
  - Write `has_terminal_for_uuid` in the current bridge build so the daemon resolver returns `deliverable` instead of `legacy-grace`.
- Why: Lex memory `project_devneural_bridge_pty_ownership.md` says "external CC sessions hook via bridge presence files, NEVER fall back to must start through dashboard." The architecture supports it; the implementation right now does not deliver. Closing this gap is what makes that memory rule true in practice.

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
