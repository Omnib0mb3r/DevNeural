# DevNeural Future Features

Forward-looking scope. Index of what's planned but not built (or only partly built). Each entry links to its spec doc when one exists, plus a one-line "why" so future-us knows whether the motivation still holds.

Last updated: 2026-09-23.

## Shipped since the last refresh (kept here so the "why" survives)

- **L2 mechanical confirm-gate before worker dispatch**: shipped 2026-09-21 as `dispatch_confirm_gate` (runtime config, default off; `07-daemon/src/lex/layer-model.ts`, FIXES.md VL-8). The daemon parks Lex's dispatch (202 `held_for_confirm`), Layer 1 asks, the operator's yes re-enters the route with a fresh token. The CC-native plan-approval prompt routes through Layer 1 too (`plan-approval.ts`), so `mid_permission_mode` `plan` works headless. Both are staged to be armed after the spoken checklist passes (`docs/HANDOVER.md` next steps).
- **Handover approval by voice, Lex self-clear, the context pack, Layer 1 respawn**: shipped 2026-09-22 (Phase C, `docs/spec/SMART-COMPACT.md` section 5).
- **Event-driven supervision**: shipped 2026-05 (spec archived at `docs/archive/spec/EVENT-DRIVEN-SUPERVISION.md`): `supervision_mode` per anchor, kill-switch, per-type spacing, hourly cap; detectors hardened 2026-09-23 (BUG-034, BUG-035). The one part not built is batching held-back events into a summary ("left for v2" in `worker-event-router.ts`); see "Decided not to do".
- **Smart-compact orchestration**: shipped; it is the context lifecycle in `docs/spec/SMART-COMPACT.md` (Phase C, one `auto_clear_mode` switch).
- **Brainstorm threading Phase 3, the LLM-backed backfill scheduler**: shipped (`07-daemon/src/daemon.ts` wires the generator; `[distill-backfill]` ticks in `daemon.log`). Cross-thread retrieval remains below.
- **Auto-discover projects**: raw top-level enumeration plus `fs.watch` shipped (Fix 52, `seedProjectAnchors`). The marker-file filter remains below. BUG-024 currently aborts the seed pass on a slug collision, so the shipped behaviour is broken until that is fixed.
- **Docs refresh punch list (2026-05)**: done; every item landed in `docs/HOW-TO-voice-and-push.md`, `docs/HOW-TO-dashboard-ux.md`, `docs/HOW-TO-supervision-pipelines.md` and `docs/spec/SMART-COMPACT.md`.

## Near term (next milestone)

### Layer 1 worker and project effects (BUG-038, in flight 2026-09-23)
- The voice can mute, approve, repeat and slow down but cannot start, stop or kill the worker, or switch project. Those effects died with the July phrase grammar and never returned as verbs. Adding `start_worker`, `stop_worker`, `panic_worker`, `switch_project` to the closed effect set, AI-interpreted like every other control; the existing routes do the work.
- Why: the operator's goal is one voice that controls the entire system with no screen. Worker control is the missing half.

### Curator canary and the injection delivery gap (BACKLOG P1)
- `CuratorHealthCard` still renders "No canary probe is wired up on the daemon yet" and `canary_status` is hardcoded `unknown`; separately, an injection can be announced without the chunk landing in context (`lex_retrieval_log` shows zero rows for an announced chunk). Source: `<DATA_ROOT>/brainstorm/BACKLOG.md` P1.
- Why: the recommendation engine is the product; an unverified delivery path means the brain may be talking to nobody.

### Stale-reply guard on the reply-text surface (BACKLOG P2)
- Barge v3 made the newest user state beat in-flight brain audio. The same rule is not enforced for the reply text that lands after the operator has already moved on. Source: `<DATA_ROOT>/brainstorm/coalescence-stale-reply-guard.md`.

### L2 mechanical confirm-gate before worker dispatch (SHIPPED, see above; entry kept for its rationale)
- Today (`3b8ef37`, 2026-07-18) the "Lex (L2) confirms alignment with the operator before it prompts the worker (L3)" rule is PROMPT-enforced in the core Lex prompt (`system-prompt.ts` worker-inject section): state the plan out loud, get the go-ahead, only then `POST /lex/inject-cross-session`. Reliable (rides the existing voice conversation) but not mechanically guaranteed.
- Future: gate `/lex/inject-cross-session` itself on an operator voice-confirm. When Lex calls it, the daemon HOLDS the dispatch, speaks the plan/intent to the operator through Layer 1, waits for a voice yes/no, then releases (dispatch) or rejects (tell Lex to revise). Bulletproof: Lex literally cannot prompt the worker until the operator agrees. Mirrors the existing loose-ends gate pattern (`enforceLooseEndsGate` on `/projects/:id/start-claude`, returns 409 + report for a banner).
- Related: route the CC-native plan-approval prompt to Layer 1 so `--permission-mode plan` works headless on the mid. Blocker: the daemon only has a time-based boot-banner prompt hold (`isAwaitingSystemPrompt`), no ExitPlanMode/plan-approval detector; needs a real detector on the mid PTY output plus an approval inject. Until then `mid_permission_mode` defaults to `bypassPermissions` (headless `plan` mode stalls on the unanswered approval); flip live with `POST /runtime-config/mid_permission_mode {"value":"plan"}` once the routing exists.
- Why: mechanical enforcement guarantees the layer contract even if the model drifts from the prompt, and it makes true CC plan mode viable for the supervisor layer.

### Decouple voice `mode` from the WS/VAD lifecycle (voice 1006 debt)
- Today (warmup lock, 2026-07-18) `mode` is a dependency of the big WS/VAD effect in `08-dashboard/components/VoiceClient.tsx` (deps `[enabled, mode]`), so switching mode (conversation / notes / push-to-talk) tears down + rebuilds the whole engine INCLUDING the WS. Switching during warmup closed a still-CONNECTING socket, which the browser reports as close code 1006 -> reconnect loop (operator repro: "switched to push-to-talk during warm, errored out"). Guarded now: the mode buttons are disabled + dimmed and `changeMode` no-ops (info toast) while `warmingUp` (status connecting/warming). ACCEPTED as the fix per operator (gate-until-warm); this future item is the deeper cleanup, not a required follow-up.
- Future: a mode switch should NEVER touch the socket. Send `{t:'set-mode'}` on the LIVE WS (already sent by `changeMode`) and reconfigure ONLY the VAD in place (pause / rebuild the ORT VAD for PTT vs conversation), mirroring the SV-3 rebind-on-live-socket pattern (`46b9347`). Then drop `mode` from the effect deps so the engine builds once per enable. That removes the teardown/rebuild blip entirely and makes the warmup gate unnecessary.
- Why: mode is a VAD concern, not a transport concern; rebuilding the socket on every mode change is fragile (the 1006 was one symptom) and blips voice, the same failure class SV-1..3 fought for brainstorm switches.

### Brainstorm threading: cross-thread retrieval
- Phases 1 to 3 shipped (sibling index, preload plus backfill, the LLM-backed scheduler). Remaining: bounded targeted retrieval across a thread so per-turn cost stays constant regardless of thread length.
- Why: brainstorms are the core artifact; arbitrary-length threads must stay cheap to load.

### Supervision tunables in settings UI
- All supervision rate limits and thresholds today are env-tunable or hard-coded; not in the dashboard. Surface in the settings page (likely a new `SupervisionSettingsPanel`):
  - WorkerEventGate per-anchor hourly cap (today ~20/10min)
  - Worker stall thresholds (`DEVNEURAL_STALL_TOOL_MS` default 5min, `DEVNEURAL_STALL_USER_MS` default 3min, stall cooldown)
  - Expectation supervisor tick interval (default 90s, new from PLAN-brainstorm-without-cc.md section L)
  - Auto-advance mode (off/shadow/live), Cold-start preload mode (off/shadow/live), Smart-compact mode (off/shadow/live) - toggles exist, just need to be on the settings page alongside everything else
- Write-through via existing `/runtime-config/:key`. Daemon reads runtime_config first, falls back to env, then defaults.
- Why: hard-coded limits are invisible; runtime control matters when supervision is misbehaving and a daemon restart isn't desired.

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

### Auto-discover projects: marker-file filter
- The seed already enumerates every top-level dir under `C:/dev/Projects` and watches for new ones. Remaining: filter by project-marker files so scratch folders do not become anchors.
- Why: matches the "everything Lex sees is discoverable from disk" model without anchoring junk.

## Decided not to do (recorded so the dismissal is on file)

Each of these was specified in a doc that is now archived. None is built, none is planned. Revisit only if the reason changes.

- **One voice, many projects** (INVESTIGATOR-PIPELINE: silent background drivers per project behind one voice). Killed by the scope rule: one brainstorm supervises one project, and Layer 1 sees only that brainstorm (`docs/spec/LAYER-1-CONTROL.md` "Scope"). Decided 2026-09-23.
- **Neutral test harness** (INVESTIGATOR-PIPELINE: two tiers, one probe per check, an evidence log). Only the optional `suiteGreen` probe exists (`lex-project-lifecycle-probes.ts`). The smoke gate is the spoken list plus `daemon.log`; a second harness would be a second source of truth. Decided 2026-09-23.
- **Supervisor event batching** (EVENT-DRIVEN-SUPERVISION: fold held-back events into one summary). The hourly cap and per-type spacing already bound the noise, and `turn_summary` carries the worker's own words. Decided 2026-09-23.
- **Worker danger gate** (INVESTIGATOR-PIPELINE: no worker ever runs with permissions bypassed). Recorded with its rationale and recovery path in `docs/FUTURE-SECURITY-CONCERNS.md` (2026-09-23 entry); revisit when Layer 1 can route a worker permission prompt.

## How to use this doc

- Adding an idea: one section under the right time horizon, plus link to spec doc if one exists.
- Promoting an idea to a phase: move the entry into the active phase plan, leave a one-line pointer here that says "shipped in commit X, see Y".
- Killing an idea: delete it, unless a spec or plan once promised it; then one line under "Decided not to do" so nobody rediscovers it as a silent drop.
