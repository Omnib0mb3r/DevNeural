# Plan: brainstorm session as durable primary entity (no CC required)

## Day in the life (user's ground truth, 2026-05-22)

This is the experience the implementation has to deliver. The technical sections below describe the mechanics that serve this.

1. Open Lex tab, click "new brainstorm", name it, press start.
2. Voice conversation flows freely. Project ideas, anything. Lex spawns markdowns and scratch artifacts as we think.
3. Decide to make a project. Tell Lex. Lex clones the GitHub template, creates the file tree on disk, drops the planning markdowns it generated during the brainstorm into the project. User opens VS Code, invokes Claude. Lex starts driving the worker. Two paths to start a coding session:
   - explicit: Lex spawns/wires it itself
   - background: bridge auto-binds to a manually launched Claude terminal
4. Dashboard shows the Lex session AND the worker session, with the Lex session visibly controlling the worker. Lex kicks the worker on the project plan.
5. Lex supervises both ways in tandem:
   - polling: periodically reads the worker's jsonl tail and compares actual vs expected to detect drift
   - event-driven: worker hits a question or stopping point → triggers Lex → Lex inspects and dispatches the next task
6. Lex manages the worker's context clearing smartly. Doesn't blind-cut. Tells the worker to reach a good stopping point first, captures structured handoff (where it was, what it was working on, what's next, summary), then clears, dumps new context, restarts.
7. Lex has the same auto-clear loop for itself. Cold-start preload is much richer than the worker's — 100k tokens is fine. Lex is the brain; resume context must be deep.
8. Either side can fully restart with a new CC session ID at any time. System auto-reattaches so DevNeural stays bound to the brainstorm. Most plumbing in place; needs solid verification.
9. Lex alerts the user via dashboard system alerts only when truly needed. Seldom.
10. Anytime conversation defers something (later, Phase 2, future date), Lex auto-creates a reminder. No manual capture required.

Brainstorm is the durable brain that owns and outlives every CC session attached to it. CC sessions are tools the brainstorm spawns, drives, clears, and respawns. Lex itself does the same dance against its own context limits.

Cold-start preload, worker handover, sibling distillations, smart-compact, cross-session inject all keep working. They get reframed as the mechanisms by which the brainstorm pushes context into whatever CC session attaches.

---

## Goal

**Existing functionality must keep working.** Cold-start preload, worker handover, sibling distillations, smart-compact, cross-session inject — all stay. They get reframed as the mechanisms by which the brainstorm (the god) pushes its accumulated context into whatever CC session attaches. Nothing gets removed; the lifecycle reverses so the brainstorm owns the CC sessions instead of the other way around.

## Current state (verified from architecture map, 2026-05-22)

- Brainstorm rows created ONLY by `pty-host.ts:spawnLex()` (registerBrainstorm at line 414). Cwd-gated by `isBrainstormCwd()`.
- Brainstorm row binds `claude_session_id` when jsonl appears.
- Voice WS `/voice/lex-ws` binds to a brainstorm via PTY id; transcribes audio → injects into the Lex PTY (a CC session running with the Lex system prompt) → CC LLM call → assistant turn appears in jsonl → watcher detects → Piper TTS streams response.
- session-end-pipeline runs on PTY exit, voice end-session, or WS close, and tears down the brainstorm.

So a brainstorm CAN exist only while a Lex CC PTY is alive. Lex is implemented as Claude Code running with the Lex system prompt; there is no separate Lex runtime.

## Architectural decision

Two ways to detach brainstorm from CC:

1. **Path A — Ephemeral CC per turn.** Brainstorm row persists. On each voice turn, daemon spawns a fresh CC PTY just-in-time, replays brainstorm context, takes the LLM response, kills the PTY. Voice WS hides this.
2. **Path B — Lex as direct LLM consumer.** Voice WS calls the daemon's LLM provider (llm/index.ts) directly with `buildLexSystemPromptVersioned()` + brainstorm transcript. No CC PTY for Lex at all. CC PTYs only exist for the worker side.

**Choose Path B.** Reasons:
- Path A spawns a fresh CC per utterance: slow, expensive, jsonl pollution, doesn't actually solve "Lex is the brain", it just hides the dependency.
- Path B matches the conceptual model: Lex is a long-running brain. CC sessions are tools Lex uses (worker driving) not prerequisites for Lex existing.
- Path B is what cross-session-inject already assumes — Lex drives a worker CC via inject; Lex itself doesn't need a CC.

## Files / tables / routes to change

### A) Schema

- `brainstorm_sessions.pty_id` → make nullable end-to-end (verify current TS / TypeScript type, may already be nullable via SQLite default; add explicit migration to drop NOT NULL if present).
- Add `brainstorm_sessions.runtime_mode` column: `'cc-pty' | 'direct-llm' | 'detached'`. Default `'direct-llm'` for new standalone brainstorms; `'cc-pty'` retained for the legacy spawnLex path.
- Add `brainstorm_sessions.lifecycle_state` column: `'idle' | 'attached' | 'speaking' | 'ended'` to track current state separate from PTY existence.

### B) Brainstorm-store helpers (`07-daemon/src/lex/brainstorm-store.ts`)

- New `createStandaloneBrainstorm({ userLabel, mode })` that inserts a row with `pty_id=null`, `claude_session_id=null`, `runtime_mode='direct-llm'`, `lifecycle_state='idle'`.
- New `attachWorkerSession(brainstormId, ccSessionId)` to bind a CC session as the brainstorm's controlled worker (separate from Lex's own pty_id).

### C) New daemon route

- `POST /brainstorms/standalone` — body `{ user_label?, mode? }`, returns new brainstorm row. Registered in `dashboard/routes.ts`.

### D) Voice WS path (`07-daemon/src/voice/lex-voice-ws.ts`)

- Accept connection params keyed on `brainstorm_id` (not just `pty_id`).
- If brainstorm has `runtime_mode='direct-llm'`:
  - On each utterance: build context via `buildLexSystemPromptVersioned()` + `chunkSearch()` over brainstorm chunks + last summary + any awareness deltas.
  - Call `pickProvider().call()` (llm/index.ts) with the assembled messages.
  - Stream response text to Piper for TTS.
  - Persist the user-turn + assistant-turn as `brainstorm_chunks` rows directly (no jsonl involved).
- If `runtime_mode='cc-pty'`: existing path (inject into PTY, watch jsonl).

### E) Brainstorm chunks for direct-llm path (`07-daemon/src/lex/brainstorm-jsonl-ingestor.ts`)

- Currently this ticks every 5s reading CC jsonls. For direct-llm brainstorms there is no CC jsonl. Add a parallel path: when the voice WS persists a chunk directly, the ingestor doesn't need to touch that brainstorm; just skip when `runtime_mode='direct-llm'`.

### F) Session-end pipeline (`07-daemon/src/lex/session-end-pipeline.ts`)

Today the pipeline always tears the brainstorm down (mark ended). For brainstorm-as-god, distillation has to keep firing whenever a "chunk" ends, without ending the brainstorm.

Split into two:

1. **`runDistillationFlush(brainstormId, opts)`** — extracted from the existing pipeline. Runs steps 1-7: stop chunk ingestor for this brainstorm momentarily, persist pending transcript, force-flush ingest, Pass 2 distillation → wiki_drafts, finalize audio (if any), refresh `last_summary` + `last_summary_ms`, write thread-doc. Does NOT mark the brainstorm ended.

2. **`runSessionEndPipeline(brainstormId)`** — calls `runDistillationFlush` then sets `status='ended'` and `ended_ms=now`. This is the terminal teardown.

Triggers:

| Trigger | Calls |
|---|---|
| Voice "end session" command | `runSessionEndPipeline` |
| Explicit "end brainstorm" UI button | `runSessionEndPipeline` |
| Worker CC session detaches from brainstorm | `runDistillationFlush` |
| Periodic chunking (every N turns or M minutes inside a long-running direct-llm brainstorm) | `runDistillationFlush` |
| Legacy CC-PTY Lex PTY exit (`runtime_mode='cc-pty'`) | `runSessionEndPipeline` (preserves current behavior) |
| Voice WS close on direct-llm brainstorm | `runDistillationFlush` (NOT end — brainstorm stays alive) |

The next attached CC session always sees an up-to-date `last_summary` and thread-doc, which is what `lex-cold-start-preamble` and `/worker/clear-handoff` already inject into a fresh SessionStart.

### G) Cold-start preload (`07-daemon/src/lex/lex-cold-start-preamble.ts`)

- Today injects sibling distillations + last 2 summaries + recent turns into a NEW Lex CC session via the SessionStart hook.
- For direct-llm brainstorms, the equivalent is the system prompt assembly inside `lex-voice-ws.ts`: it must include the same context, every turn (not just first turn).
- For worker CC sessions attaching to a brainstorm: the SessionStart hook `/worker/clear-handoff` should also dump the brainstorm's accumulated context (`last_summary` + recent chunks) into the worker's first turn. That's the "fresh CC picks up the thread" piece.

### H) PTY host changes (`07-daemon/src/dashboard/pty-host.ts`)

- `spawnLex` keeps the legacy `runtime_mode='cc-pty'` path.
- PTY exit handler: only run session-end-pipeline if the brainstorm's `runtime_mode='cc-pty'`. For direct-llm brainstorms there is no Lex PTY to exit.
- Worker PTY exit: just detach the worker from the brainstorm, don't end the brainstorm.

### I) Dashboard UI

- `08-dashboard/app/brainstorms/page.tsx`: add "+ New Standalone Brainstorm" button → POST `/brainstorms/standalone`. List shows `runtime_mode` and `lifecycle_state` columns.
- `08-dashboard/components/BrainstormDetail.tsx`: show whether a worker CC is attached, button to attach/detach a CC session via supervises picker.
- `08-dashboard/components/VoiceClient.tsx`: when connecting to a brainstorm, pass `brainstorm_id` (not just `pty_id`). Voice should bind by brainstorm identity now.

### J) Bridge / cross-session inject

- No change. Cross-session inject already operates against worker CC sessions by `target_session` or `signed_anchor_id`. Lex (direct-llm) using cross-session-inject works identically.

### K) Memory + docs index (separate spec, already injected)

- The three-tier per-turn index spec already covers the live_state additions for memory_index and docs_index. They become part of the system-prompt assembly in the direct-llm path too. No additional work here beyond making sure the assembler includes them.

### L) Active polling-with-expectations supervisor

Today: worker-stall-watch ticks every 60s and detects tool-stall (>5min) or no-user-response (>3min). That's reactive stall detection only. Not expectation-based.

Add: brainstorm-driven expectation tracking. When Lex dispatches a task to the worker, Lex stores a structured expectation row (anchor_id, expected_outcome, expected_files, expected_duration_ms, created_at). The polling tick reads recent worker jsonl turns and asks: does what the worker is doing align with the expectation?

New table `lex_worker_expectation`:
- id PK
- brainstorm_id FK
- anchor_id FK (worker session)
- expected_outcome (text — what Lex told the worker to accomplish)
- expected_files (json array of likely files)
- expected_duration_ms
- created_at
- closed_at (null while active)
- closed_reason (`completed` | `drifted` | `superseded` | `cancelled`)

New module `07-daemon/src/lex/expectation-supervisor.ts`:
- `recordExpectation(brainstormId, anchorId, payload)` — called whenever Lex's voice WS / inject path dispatches a task.
- `evaluateExpectation(expectationId)` — reads recent worker jsonl turns, calls the LLM provider with a compact prompt: "given expected_outcome X, does the worker's recent activity match? Return {aligned: bool, drift_summary: string, suggested_correction: string}".
- `runExpectationTick()` — 90s interval, walks open expectations, calls evaluateExpectation, on drift fires `fireForCustom` lex-attention so Lex can inject a correction.

Wire into `daemon.ts` schedulers table.

### M) Auto-reminder on deferral

Today: meeting notes-summary artifacts already extract action items into `meeting_action_items`. Reminders are manual otherwise.

Add: deferral detection on every brainstorm turn. When Lex's response or the user's turn contains deferral phrases (regex + LLM gate), auto-create a reminder.

Implementation:
- In the direct-llm voice WS path, after each assistant turn lands, run a cheap pass over the turn text (regex: `\b(later|phase 2|defer|push (this )?off|future|nice to have|when we get to|down the road)\b`). On regex hit, call the LLM with a 2-sentence prompt: "did the user defer a concrete task in this turn? If yes, return {defer: true, task: string, suggested_when: string|null}".
- On `defer: true`, insert a `reminder_log` row + a brainstorm artifact of kind `deferral` so it shows in the BrainstormDetail panel.

Reuse existing `dashboard/reminders.ts` `createReminder` helper. New artifact kind `deferral` added to `lex/artifact-parser.ts`.

### N) Active-supervision dashboard surface

`08-dashboard`: show the brainstorm's currently-open expectations in `BrainstormDetail`. Show a deferrals list. Show the worker's last-evaluated alignment score.

No new daemon endpoints needed if we reuse `/brainstorms/:id` + a join on the new expectation table.

## Lifecycle states (new)

| state | meaning | enter from | exit to |
|---|---|---|---|
| idle | brainstorm row exists, no voice WS connected, no worker attached | initial create | speaking, attached, ended |
| attached | worker CC session bound; idle Lex (no voice in flight) | idle when worker binds | idle (worker detaches), speaking |
| speaking | voice utterance in flight (mic open or TTS streaming) | idle/attached | idle/attached |
| ended | session-end-pipeline run, archived | any | terminal |

## Acceptance

1. From a clean daemon, click "+ New Standalone Brainstorm" in the dashboard. Brainstorm row appears with `runtime_mode='direct-llm'`, no PTY, `lifecycle_state='idle'`.
2. Click voice connect on that brainstorm. Speak. Get a Piper TTS reply. No CC PTY was ever spawned. Brainstorm chunks appear in DB.
3. Close the voice connection. Brainstorm stays in `idle`. Open it again hours later. Speak. Lex responds with context from the prior session (last_summary picked up).
4. Attach a worker CC session via supervises picker. Worker's first turn gets the brainstorm's accumulated context as SessionStart preamble.
5. Run `/clear` in the worker. New CC session under the same anchor. Same preamble dump. Brainstorm unaffected.
6. Voice "end session" command. session-end-pipeline runs. Brainstorm flips to `ended`. Distillation written.

## Rebuild

07-daemon + 08-dashboard on every commit.

## Sequence

1. Schema migration (mig 033): add columns, drop NOT NULL on pty_id if present.
2. brainstorm-store helpers + new route.
3. Voice WS direct-llm path + chunk persistence.
4. Worker SessionStart preamble dump.
5. Session-end-pipeline branch.
6. Dashboard UI: standalone button + lifecycle/runtime columns + voice client brainstorm_id.
7. Regression smoke: legacy spawnLex path still works for backwards compatibility (do not break existing brainstorms mid-flight).

---

# Doc audit vs locked ground truth (2026-05-22)

Audit scope: every `.md` file under `C:/dev/Projects/DevNeural/docs/` and `C:/dev/Projects/DevNeural/docs/spec/`. Dated `HANDOVER-<date>` files are skipped per the audit charter (point-in-time by design). This document itself is the source-of-truth and is not audited. The canary fixture file (`docs/spec/canary-fixtures.json`) is not markdown and is not audited.

Truths enforced (T1 brainstorm-is-primary, T2 direct-llm runtime, T3 cold-start/handover/sibling/smart-compact/cross-session-inject still work as push mechanisms, T4 distillation-flush vs session-end split with new triggers, T5 Lex cold-start preload is richer, T6 expectation-supervisor + 90s tick + lex_worker_expectation table, T7 auto-reminder on deferral phrases).

| File | Category | Conflict (cite line numbers) | Recommendation |
|---|---|---|---|
| `C:/dev/Projects/DevNeural/docs/ARCHITECTURE-MAP.md` | NEEDS_AMENDMENT | Describes brainstorm creation as gated by `pty-host.ts:spawnLex()` and `isBrainstormCwd()` only (mirrors the same statements summarized in PLAN section "Current state"). Sections at lines 683-684 (`pty-host.ts` exports `spawnLex, bindBrainstormSessionId, isBrainstormCwd, getBrainstormByPty`), 899-901 (`brainstorm-store.ts` exports `createBrainstorm` but no `createStandaloneBrainstorm` / `attachWorkerSession`), 979-980 (session-end-pipeline described as a single 8-step terminal path with no `runDistillationFlush` vs `runSessionEndPipeline` split), and 1097-1099 (voice WS hard-binds to a Lex PTY and watches jsonl for assistant turn). No mention of `runtime_mode` column or direct-llm path. T1, T2, T4 all contradicted by omission. | Add new exports for the standalone path. Add `runtime_mode` and `lifecycle_state` columns to the `brainstorm_sessions` row in the schema table at line 1196 area. Split session-end-pipeline description into the two functions. Document the voice WS direct-llm branch alongside the existing PTY+jsonl branch. Keep the doc accurate as code lands. |
| `C:/dev/Projects/DevNeural/docs/CLEANUP-TODO.md` | NO_CONFLICT | Pure janitorial backlog, no architectural claims. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/DISASTER-RECOVERY.md` | NO_CONFLICT | Snapshot/restore runbook; treats brainstorm memory + index.db + jsonls as restore targets, which still holds. Line 13 says "On brainstorm end if the conversation contained durable corrections" which is still valid under the new model (the runSessionEndPipeline trigger still exists). | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/FUTURE-FEATURES.md` | NO_CONFLICT | Forward-looking index. Doesn't claim a current implementation. | Leave alone. Optionally add a one-liner pointing at PLAN-brainstorm-without-cc.md as the next-milestone substrate. |
| `C:/dev/Projects/DevNeural/docs/FUTURE-SECURITY-CONCERNS.md` | NO_CONFLICT | Loopback-auth bypass note; orthogonal to brainstorm lifecycle. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/HOW-TO-dashboard-serving.md` | NO_CONFLICT | Static-serve + Tailscale wiring; no brainstorm claims. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/HOW-TO-dashboard-ux.md` | NO_CONFLICT | Panic button, transcript history panel, collapse pattern. Independent of brainstorm runtime. Line 91-94 voice command "Lex end session" routes through `fireSessionEndPipeline`; still true under the new split (it should call `runSessionEndPipeline` per the new naming). | Leave alone for now. If file is touched, rename callout to `runSessionEndPipeline` to match the new split. |
| `C:/dev/Projects/DevNeural/docs/HOW-TO-supervision-pipelines.md` | RECONCILE | Lines 196-282 describe event-driven supervision as the active polling-replacement story. Lines 409-559 describe a daemon-side auto-advance loop that fires `crossSessionInject` on clean-idle-done worker turns. New PLAN section L introduces a parallel **expectation-supervisor** module with its own `lex_worker_expectation` table and 90s tick. These two systems share routing surface (`resolveLexTargetSession`, `crossSessionInject`, `lex-attention`) and both want to react to worker drift. The doc does not yet describe how expectation-supervisor coexists with event-driven supervision and the auto-advance loop. T6 says expectation tracking is additive, but the doc presents the existing pipelines as comprehensive coverage. | See follow-up paragraph below. |
| `C:/dev/Projects/DevNeural/docs/HOW-TO-voice-and-push.md` | NEEDS_AMENDMENT | Line 55-56 says: "Voice path: utterance frames -> WS `/lex/voice` -> daemon whisper -> daemon inject -> `assistant-text` event -> Piper TTS frames back over the same WS." Under T2 the direct-llm path does NOT inject into a CC PTY; it calls `pickProvider().call()` directly and persists chunks. Line 49-56 wording is correct for legacy `runtime_mode='cc-pty'` only. | Split the "what it does" description into two branches keyed on `runtime_mode`. Make explicit that the inject-into-PTY step is the legacy path. Reuse the same language PLAN section D uses. |
| `C:/dev/Projects/DevNeural/docs/INDEX.md` | NEEDS_AMENDMENT | Pure pointer file. No conflicts itself; but missing an entry for `PLAN-brainstorm-without-cc.md` (which is the new ground-truth doc). | Add one line under "Top-level" pointing at `PLAN-brainstorm-without-cc.md` with a brief description of "brainstorm-as-durable-primary-entity ground truth". |
| `C:/dev/Projects/DevNeural/docs/PLAN-2026-05-12-evening.md` | SHOULD_ARCHIVE | Worker queue from 2026-05-12 (A1 LLM backfill wiring, A2 supervision_mode UI, etc). Every concrete code item it asked for is either shipped or has been folded into other specs (see HOW-TO-supervision-pipelines). Line 49-56 verification ladder is point-in-time. | Move to a historical/archive subfolder when convenient. No live claims to amend. |
| `C:/dev/Projects/DevNeural/docs/POSTMORTEM-2026-05-17-voice-tts-stale-shell.md` | NO_CONFLICT | TTS silence postmortem; root cause is operational (stale dist + dashboard shell), not architectural. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/SESSION-HANDOVER.md` | SHOULD_ARCHIVE | Top header says "Last updated: 2026-05-10 late evening (Phase Two Wave 2 complete)." Multiple "State now" blocks dated 2026-05-04 through 2026-05-10. Refers to current branch as `phase-two`, recent commits ending at `32fe1bb feat(lex): wave 2 day 5`. Line 21 calls Phase 3.4 dashboard "NOT STARTED" yet other docs show the dashboard fully shipped through Phase 3.7+. Line 437-44 "Phase 3.4 dashboard frontend next, correct?" framing is obsolete. The file even predates Wave 3 / Wave 4. Multiple statements about brainstorm row lifecycle: line 39 "session-to-session handoff documents become obsolete" - which is what PLAN now is doing differently. Not aligned with current model end-to-end. | Archive or rewrite from scratch. The file's "first file a new Claude reads" purpose is now better served by PLAN-brainstorm-without-cc.md plus INDEX.md. |
| `C:/dev/Projects/DevNeural/docs/SESSION-START-INJECTIONS.md` | NEEDS_AMENDMENT | Lists only two injections (`caveman-activate`, `cold-start-preload`). Under T3, the worker SessionStart preamble is also load-bearing: PLAN section G says `/worker/clear-handoff` should dump the brainstorm's `last_summary` + recent chunks into the worker's first turn. That injection is not listed. | Add a third row for the worker-side brainstorm-context preamble once the SessionStart hook lands. The new row should match the existing format (Name / Purpose / Hook entry point / Toggle / Notes). |
| `C:/dev/Projects/DevNeural/docs/SMOKE-TEST.md` | NO_CONFLICT | Open-items checklist. Items "Lex cold-start context preload" (line 10) and brainstorm threading items reflect existing behavior that PLAN re-frames but does not remove. | Leave alone. After PLAN lands new smokes will get added here. |
| `C:/dev/Projects/DevNeural/docs/SMOKE-lex-session-rewrite-2026-05-16.md` | NO_CONFLICT | Verification log for commit `5af07d0` (`lex_session` anchor model). The verified `lex_session` anchor surface still holds under PLAN (Lex's own anchor row, durable across CC restarts; brainstorm row sits ABOVE lex_session in the new model). | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/voice-commands.md` | NEEDS_AMENDMENT | Line 47-55 says "`lex end session` ... Effect: ends the current Lex brainstorm session. Runs the session-end pipeline (force-ingest, summary, RAG embed). The brainstorm row archives". Under PLAN section F the trigger table is more nuanced: voice "end session" still archives the brainstorm via `runSessionEndPipeline`, but a worker CC session detaching or voice WS close on a direct-llm brainstorm calls `runDistillationFlush` instead (brainstorm stays alive). The current copy is still correct for the explicit voice "Lex end session" path; what's missing is the distinction from "voice WS close" (which today is also documented elsewhere as triggering session end). | Tighten the "Effect" sentence to say "Lex's voice command runs `runSessionEndPipeline` and archives the row. Closing the voice WS without saying this no longer archives the brainstorm; it just flushes distillation." Add a one-line note that brainstorm now outlives voice WS sessions. |
| `C:/dev/Projects/DevNeural/docs/bugs/README.md` | NO_CONFLICT | Index of open + closed bugs. No architectural claims. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-05-leftover-session-tiles.md` | NO_CONFLICT | Historical (closed). | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-10-brainstorm-picker-and-transcripts.md` | NO_CONFLICT | Picker + transcript chunks bug; the chunks API surface this added remains valid. Line 75-94 root cause talks about `BrainstormList` 60s staleTime; new model unaffected. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-10-cc-feedback-prompt-unanswerable.md` | NO_CONFLICT | Feedback prompt bug; orthogonal to brainstorm lifecycle. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-10-state-tracker-loses-live-sessions.md` | NO_CONFLICT | StreamDeck identity directory empty-set vs null-set bug. Independent of new model. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-11-cannot-resume-past-brainstorms.md` | RECONCILE | Line 45-52 fix: "drop the `activePtyId` part of the disabled check. The resume mutation now does the same kill-then-spawn dance as the page-level new session button (`ptyKill` + patch the old brainstorm row to `status: 'ended'` + 400ms gap...)." Under T1 the brainstorm survives PTY death; "kill-then-spawn + mark ended" is the exact lifecycle PLAN reverses. A user resuming a past brainstorm in the new model should NOT need to end the current Lex PTY (there may not even be a PTY in direct-llm mode), and the past brainstorm should be re-activated by attaching voice WS to its `brainstorm_id`, not by spawning a CC PTY with `--resume <claude_session_id>`. | See follow-up paragraph below. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-11-dashboard-small-screen-overflow.md` | NO_CONFLICT | CSS overflow. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-11-push-to-talk-not-releasing-mic.md` | NO_CONFLICT | Voice client mic-release bug. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-14-bridge-inject-missing-enter.md` | NO_CONFLICT | Bridge inject CR; orthogonal. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-14-enable-audio-double-permission-prompt.md` | NO_CONFLICT | Browser audio permission UX. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-14-no-tts-on-first-prompt-after-restart.md` | NO_CONFLICT | TTS race condition. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-14-pwa-reminders-not-pushing.md` | NO_CONFLICT | Web push pipeline. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-14-vad-scriptprocessornode-deprecation.md` | NO_CONFLICT | VAD path; browser API. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-14-voice-pill-inconsistent-and-wake-word-muted.md` | NO_CONFLICT | UI state machine. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-14-wake-word-unmute-stuck.md` | NO_CONFLICT | Wake-word state machine. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-16-cc-feedback-prompt-keystrokes-leak-to-brainstorm.md` | NO_CONFLICT | Screenshot-text feedback loop into Lex PTY. Still occurs in legacy `runtime_mode='cc-pty'`; not an issue under direct-llm because there is no daemon-owned Lex PTY to write to. | Leave alone. Optional note: bug only applies under legacy cc-pty mode. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-16-feedback-auto-dismiss-misses-bridge-sessions.md` | NO_CONFLICT | Bridge feedback dismissal. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-16-voice-cmd-blocked-during-tts.md` | NO_CONFLICT | TTS gating voice cmd. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-16-voice-restart-oom-regression.md` | NO_CONFLICT | VAD/ORT singleton lifecycle. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-22-lex-blind-to-worker-on-cold-start.md` | NO_CONFLICT | Cold-start delivery-verdict bug; closed via `resolveDeliverableBridgeForSession`. Aligned with T3 (cold-start preload still works). | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-22-tts-bargein-regression.md` | NO_CONFLICT | Watchdog clearing `ttsActiveRef` on barge-in. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/bugs/2026-05-22-worker-discovery-both-launch-paths.md` | NO_CONFLICT | `has_terminal_for_uuid` deliverability flag. Same root as the cold-start bug. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/01-prerequisites.md` | NO_CONFLICT | Install prereqs. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/02-architecture-and-dependencies.md` | NO_CONFLICT | Static architecture overview. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/03-files-and-paths.md` | NO_CONFLICT | Path map. One mention of `OTLC-Brainstorm.MD` at line 189; not a runtime claim. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/04-step-by-step.md` | NO_CONFLICT | Install steps. Only incidental mentions. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/05-coexistence-with-claude-setup.md` | NO_CONFLICT | Settings.json coexistence. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/06-recovery-and-reconstruction.md` | NO_CONFLICT | Recovery runbook. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/07-troubleshooting.md` | NO_CONFLICT | Troubleshooting. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/08-personalized-recovery.md` | NO_CONFLICT | Personalized recovery. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/AUDIO-VIDEO.md` | NO_CONFLICT | Audio/video pipeline notes. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/HEARTBEAT.md` | NO_CONFLICT | Heartbeat watcher. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/NOTIFICATIONS.md` | NO_CONFLICT | Push notifications. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/install/TAILSCALE.md` | NO_CONFLICT | Tailscale wiring. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/superpowers/plans/2026-04-02-organic-edges.md` | NO_CONFLICT | Orb edge rendering plan. Independent. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/superpowers/specs/2026-04-02-organic-edges-design.md` | NO_CONFLICT | Orb edge design. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/CODEX-REVIEW-001.md` | NO_CONFLICT | Codex critique of Phase Two Implementation. Historical, traceability-only per its own preface line 7. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/CODEX-REVIEW-002.md` | NO_CONFLICT | Codex critique part 2. Historical. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/DEVNEURAL.md` | NO_CONFLICT | Wiki schema spec (`[trigger] -> [insight]`, frontmatter, lint rules). Brainstorm-orthogonal. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/EVENT-DRIVEN-SUPERVISION.md` | NEEDS_AMENDMENT | Line 41-55 routes daemon events through "the existing cross-session inject pipeline... injects to Lex's CC session UUID (resolved from the `lex_session` anchor flagged as the active brainstorm)." Under T2 there is no Lex CC session UUID in direct-llm mode. The router still works because it resolves Lex's TARGET via brainstorm, but the doc still refers to it via `lex_session.cc_session_id`. | Update the routing description to say: events still route to "the brainstorm row" and the brainstorm decides how to deliver (push into voice WS / inject into legacy Lex PTY / surface via dashboard alert). The `resolveLexTargetSession` cache may need to switch from CC-session-UUID-keyed to brainstorm-id-keyed. |
| `C:/dev/Projects/DevNeural/docs/spec/FUNCTIONAL-SPEC.md` | RECONCILE | Multiple lines anchor on the "brainstorm exists only while a Lex CC PTY is alive" model: line 351-353 "Lex is the always-available coworker... Implemented as a daemon-owned PTY hosting a `claude` CLI process"; line 429-438 brainstorm row "Created at PTY spawn... Ended at PTY exit OR voice end-session command OR daemon-detected eviction"; line 439-461 session-end-pipeline described as monolithic; section 17 (phase-two roadmap) is also stale relative to the locked plan. The doc is labeled "Single source of truth for how every component currently works" at line 3 - that framing IS the conflict. Under T1, T2, T4 these claims need to be reframed as the legacy `runtime_mode='cc-pty'` path. T5/T6/T7 entirely missing. | See follow-up paragraph below. |
| `C:/dev/Projects/DevNeural/docs/spec/FUTURE-DAEMON-SPLIT.md` | NO_CONFLICT | Future three-plane split (07-core / 07-voice / 07-memory). PLAN does not foreclose this; the direct-llm path lives in voice plane the same way today's WS does. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/PANIC-BUTTON.md` | NO_CONFLICT | Panic button targeting + transport. Independent of brainstorm runtime model. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/PHASE-8-RELIABILITY-PLAN.md` | RECONCILE | Lines 40-51 ("PTY survival across daemon restart") frame the survivability problem as "kill daemon process while a Lex brainstorm is active, daemon restarts, brainstorm voice WS reconnects and the same Lex session resumes (no new session id, no lost context)." Under T1 + T2 the survivability story changes shape: a brainstorm doesn't need a Lex CC session at all to survive; what survives is the brainstorm row. The "Approach A vs Approach B" PTY-survival framing assumes Lex is a PTY. With direct-llm Lex, the survival problem reduces to: voice WS reconnect + worker PTY reattach. Approach A/B is still useful for worker PTYs but not for Lex itself. | See follow-up paragraph below. |
| `C:/dev/Projects/DevNeural/docs/spec/PHASE-TWO-DAY-1-VERIFICATIONS.md` | NO_CONFLICT | Q&A verification log from 2026-05-10 Wave 1 day 1. Historical / traceability. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/PHASE-TWO-IMPLEMENTATION.md` | RECONCILE | Authoritative Phase Two spec. Section 2.1 BF-7 line 90 says "Wiki distillation at brainstorm session end is automatic" with session-end being the trigger. Section 3.3 lines 246-294 add columns to `brainstorm_sessions` but do not include `runtime_mode` or `lifecycle_state`. Wave 1 day 2 step 20 (lines 1216-1228) mandates an atomic 8-step session-end pipeline with the third step "Persist the final transcript and update `brainstorm_sessions.ended_at`" - which contradicts T4 (distillation needs to fire on more triggers WITHOUT marking ended). Appendix E (line 1995 onward) worked examples conclude every brainstorm by setting ended_at; line 2000-2008 explicitly describes Stop as the path that "Set distilled_at" and tear-down. T4 distillation-flush-without-end is missing across the entire spec. | See follow-up paragraph below. |
| `C:/dev/Projects/DevNeural/docs/spec/PROJECT-ANCHORS.md` | NO_CONFLICT | Project anchor model (`project_session` table). Worker side, not brainstorm side. PLAN's worker-attach flow uses these anchors as-is. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/SMART-COMPACT.md` | NEEDS_AMENDMENT | Line 39-46 wrap-and-commit prompt assumes Lex itself injects into the worker via cross-session-inject. Under T3 this still works as a push mechanism from brainstorm to attached worker. The doc says "Lex orchestrates" which presumes Lex is a CC PTY in places (line 124 "Lex orchestrates, daemon executes"). Under T2 Lex IS the brainstorm + voice WS + direct LLM consumer. The doc is salvageable but should say "the brainstorm orchestrates via the voice WS direct-llm path, calling out to the worker via cross-session inject." | Update the framing pass: replace "Lex" subject (when used to mean a CC session) with "the brainstorm". The cross-session-inject and clear-then-refresh mechanics are unchanged. |
| `C:/dev/Projects/DevNeural/docs/spec/STREAMDECK-DEVNEURAL-ALIGNMENT.md` | NO_CONFLICT | Stream Deck client + project-anchor wire-up. Worker-side; brainstorm-orthogonal. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/WAVE-3-FIXUP-PLAN.md` | SHOULD_ARCHIVE | Historical sprint plan from 2026-05-11. All bugs closed. | Move to historical or delete after sprint retrospective is captured elsewhere. |
| `C:/dev/Projects/DevNeural/docs/spec/WAVE-3-PLAN.md` | SHOULD_ARCHIVE | Wave 3 design notes; everything either shipped or moved into FUTURE-FEATURES. | Archive. |
| `C:/dev/Projects/DevNeural/docs/spec/WAVE-4-PLAN.md` | SHOULD_ARCHIVE | Wave 4 plan; subsumed by Phase Two implementation status and the new brainstorm-without-cc work. | Archive once Phase Two is closed out. |
| `C:/dev/Projects/DevNeural/docs/spec/WAY-FORWARD.md` | SHOULD_ARCHIVE | Post-Wave-3 sequencing from 2026-05-11. Step ordering is stale; the current way forward is PLAN-brainstorm-without-cc.md. | Archive. |
| `C:/dev/Projects/DevNeural/docs/spec/devneural-v2.md` | NO_CONFLICT | v2 architecture lock from 2026-05-02. Identity-level (second-brain) doc; doesn't constrain brainstorm runtime. Lines 4-7 themselves say "design lock" but it's about the wiki/RAG identity, not the Lex runtime which is a Phase Two add-on. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/phase-3-dashboard.md` | NO_CONFLICT | Dashboard design spec (2026-05-02). Phase 3 shipped. | Leave alone or fold into a historical archive once it has no live consumers. |
| `C:/dev/Projects/DevNeural/docs/spec/phase-4-orb.md` | NO_CONFLICT | Orb rebind. Orthogonal. | Leave alone. |
| `C:/dev/Projects/DevNeural/docs/spec/phase-5-settings-audit.md` | NO_CONFLICT | Settings audit (complete per its own line 3). | Leave alone. |

## Reconcile follow-ups

**HOW-TO-supervision-pipelines.md and the expectation-supervisor overlap.** What the spec might break: today the daemon already has three layers of supervision that can fire `crossSessionInject` against a worker (worker-event-router, auto-advance-supervisor, manual Lex inject from voice WS). Adding `expectation-supervisor` as a fourth makes the per-anchor rate limiter (`WorkerEventGate.perAnchorHourlyCap`) the single chokepoint protecting the worker's context from auto-inject spam, and that gate is currently keyed on `WorkerEventType` enums (`permission_denied`, `test_failure`, `commit`, `idle`) which expectation-drift doesn't fit. If expectation-supervisor calls `crossSessionInject` directly without registering an event type, it bypasses the gate. How to reconcile: either (a) add a new event type `expectation_drift` and route expectation-supervisor through `WorkerEventGate` so the hourly cap covers all four supervisors uniformly, or (b) move the rate-limit chokepoint into `crossSessionInject` itself, keyed on `caller_label`, so any future supervisor inherits the cap by default. Option (b) is the cleaner design and matches the spec's HMAC + allowlist + audit chokepoint. The supervision doc then gets a new section 8 documenting expectation tracking alongside the existing four.

**bugs/2026-05-11-cannot-resume-past-brainstorms.md fix.** What the spec might break: that fix (drop `activePtyId` from disabled check, kill-then-spawn, set `status='ended'` on the OLD brainstorm before resuming the past one) IS the lifecycle the new plan inverts. Under T1 you don't need to end the current brainstorm to attach voice WS to a past one; you just point the voice WS at the chosen `brainstorm_id`. Under T2 there is no PTY to kill in direct-llm mode. The bug fix is therefore correct for the legacy `runtime_mode='cc-pty'` brainstorms (where the resume button needs to spawn a fresh CC with `--resume <claude_session_id>`) but actively wrong for new direct-llm brainstorms. How to reconcile: the resume button's mutation needs a `runtime_mode` branch. For `cc-pty` rows, keep the existing kill-then-spawn-with-resume dance. For `direct-llm` rows, just `voiceClient.connect({brainstorm_id})` and let the voice WS pick up. The button label "switch to" stays informative; the underlying action diverges. Also note: the old brainstorm should NOT be flipped to `status='ended'` automatically when the user resumes a past one - that's destructive. The current Lex brainstorm should drop to `lifecycle_state='idle'` (voice disconnected) and the past one's lifecycle_state goes to `speaking`. The 400ms gap for Windows taskkill /F /T tree unwind is moot when there is no PTY tree.

**FUNCTIONAL-SPEC.md.** What the spec might break: this doc is labeled the single source of truth at line 3 and is explicitly recommended as the read-first artifact from INDEX.md and other docs. If anyone reads it expecting current behavior (sections 10 and 11), they will implement against the cc-pty model and miss the new lifecycle entirely. Specific contradictions: section 10.1 hard-codes "Lex is... Implemented as a daemon-owned PTY"; section 11.1 says brainstorm row "Created at PTY spawn" and "Ended at PTY exit OR voice end-session command OR daemon-detected eviction"; section 11.2 frames session-end-pipeline as the only path that touches `last_summary` + drafts. Section 17 phase-two roadmap is also stale (Layer-6 awareness was overtaken by Phase Two LX-8 three-level model and now by the brainstorm-as-god flip). How to reconcile: this doc needs a structured update, not piecemeal edits. The cleanest path is to rewrite sections 10 and 11 in two halves each: "Legacy cc-pty path" (current text) and "Direct-llm path (new default)". Section 17 phase-two roadmap should be deleted; FUTURE-FEATURES + PLAN-brainstorm-without-cc carry that scope now. Add a new section 11.4 covering the two new tables (`lex_worker_expectation`, the `runtime_mode`/`lifecycle_state` columns) and the trigger table from PLAN section F.

**PHASE-8-RELIABILITY-PLAN.md.** What the spec might break: "PTY survival across daemon restart" framed the resilience target as keeping the Lex CC PTY alive. Under T1 + T2 the resilience target is just "the brainstorm row survives". The brainstorm IS the durable thing, and the things attached to it (voice WS, worker CC PTY) can disconnect/reconnect freely. Approach A (detached PTY child processes with named-pipe handoff) and Approach B (separate pty-host worker pool) are still relevant for worker PTYs, but they don't apply to Lex at all in direct-llm mode. Acceptance criterion at line 51 ("brainstorm voice WS reconnects and the same Lex session resumes (no new session id, no lost context)") needs rewording: "voice WS reconnects to the same brainstorm row; no Lex CC session is involved." How to reconcile: split the priority-2 scope into "Worker PTY survival" (keeps Approach A/B language) and "Voice WS reconnect against brainstorm" (a simpler problem because the brainstorm row is in SQLite and the voice WS just rebinds on `brainstorm_id`). Drop the framing that ties Lex to PTYs. Update the acceptance criterion accordingly.

**PHASE-TWO-IMPLEMENTATION.md.** What the spec might break: this is the executable spec for Phase Two and the schema migrations it dictates are about to ship (or have shipped). The fundamental conflict is BF-7's "session-end pipeline runs Pass 2 against the full transcript and writes pending wiki drafts" plus Appendix E.1's worked example, which together hardwire "session end means brainstorm ends" semantics into the implementation. Under T4 the distillation needs to fire more often than just at session end, and "session end" must be split into "flush" (non-terminal) and "terminate" (terminal). Schema migration 033 from PLAN section A adds `runtime_mode` and `lifecycle_state` columns that this spec doesn't account for. If Phase Two implements the 8-step pipeline as written (line 1216-1228) before the split lands, every voice-WS-close on a brainstorm tears the row down and the new model breaks at runtime. How to reconcile: do not implement Phase Two step 20 (BF-7 atomic session-end pipeline) as the single terminal path. Implement `runDistillationFlush` as the first body of work, then layer `runSessionEndPipeline` as `runDistillationFlush + mark ended + ended_ms`. The 8-step ordering in PHASE-TWO-IMPLEMENTATION is still valuable; it just needs to be applied inside `runDistillationFlush` rather than terminating the brainstorm. Appendix E worked examples then need a second walk-through for "voice WS closes but brainstorm stays alive" so future implementers see the non-terminal path explicitly.
