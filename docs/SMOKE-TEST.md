# DevNeural Smoke Test Checklist

Live punch list of things shipped in code but not yet verified end-to-
end on real hardware. Refresh as items get verified or new code lands.
Source of truth for the daily smoke gate; rolling cursor for the rest
of the state lives in `docs/HANDOVER.md`.

Last refreshed: 2026-05-29 (Fix 47 + Fix 48 + Fix 49 + Fix 50 + Fix 51
cycle).

## Recovering this checklist in a fresh Lex session

If the active CC Lex session ends mid-smoke (crash, /clear, restart),
the task panel disappears. To rebuild:

> Tell Lex: **"rebuild smoke task list from SMOKE-TEST.md"**

Lex reads this file, recreates every `[ ]` item as a task, preserves
`[x]` marks, and resumes from wherever it was. The Markdown file is
the source of truth; the task panel is just the live view.

## ACTIVE BATCH (2026-05-29) — LEX-AUTONOMY codex 10/11/12 + PRELOAD-1 + cc-pty double-talk

Gate: all green required before the next ship cycle opens. Each step
below has a daemon-side check that runs from any shell + an operator-
side check that needs voice or a phone in hand.

### Step 0 — Prep (one-time, before any test below)

- [x] **0.1** Daemon rebuild. `cd C:/dev/Projects/DevNeural/07-daemon
  && npm run build`. Required for every Fix 47-51 commit.
- [x] **0.2** Dashboard rebuild. `cd C:/dev/Projects/DevNeural/08-
  dashboard && npm run build`. Required for the LooseEndsBanner
  component (codex 10c).
- [x] **0.3** Daemon restart. Operator kill + relaunch (per the hard
  rule, this is operator-only). Confirm `/health` returns
  `ok: true` with a fresh pid + uptime under one minute.
- [x] **0.4** Dashboard hard reload (Settings → reset) to pick up the
  fresh static bundle. Verify the dev server at port 3000 reloaded
  too.

### Step 1 — Fix 47 codex 10 loose-ends gate

Goal: every spawn surface (smart-compact `/clear-and-paste`, dashboard
`/projects/:id/start-claude`, voice `lex start project ...`) blocks
on operator loose ends and auto-resolves auto-disposition ends.

- [ ] **1.1** From dashboard, seed a dirty worktree in the active
  brainstorm's cwd (`echo x > scratch.txt`). Click Start Claude on a
  project anchor with `anchor_id` set in the body. Expect HTTP 409
  + `loose_ends` payload; `LooseEndsBanner` renders at the top of
  the page; banner color tracks highest severity (rose for alert).
- [ ] **1.2** Click "Dismiss for 5 min". Banner unmounts. Click Start
  Claude again within 5 min; banner stays dismissed (mute entry
  honoured via `isLooseEndsBannerDismissed(anchorId)`).
- [ ] **1.3** Voice: `lex start project devneural` (or whichever
  registry name is bound). Expect spoken confirmation, OR enumerated
  loose ends on 409.
- [ ] **1.4** Force an `undistilled_ref` (start + stop a brainstorm
  with no LLM provider). Trigger `/clear-and-paste`. Expect
  `decision: 'auto-resolving'` log line + `cross_session_injection
  _log` row with `caller_label='loose-ends-auto-resolve'`.

### Step 2 — Fix 48 codex 11 grooming watch

Goal: 30-min tick walks brainstorm anchors and surfaces six gap
classes through the notifications pipeline; alert severity reaches
push, info stays bell-only.

- [ ] **2.1** Daemon boot log shows `grooming-watch: started` after
  cancelled-tool-recovery on a fresh launch.
- [ ] **2.2** `GET /lex/grooming/recent?limit=10` returns an array
  sorted ts DESC; filter is `source='grooming-watch'`. Initially
  empty on a fresh DB.
- [ ] **2.3** Seed a brainstorm with no `last_summary` and
  `started_ms` >24h old. Wait one grooming tick. Expect
  `idle_no_distill` row in `/lex/grooming/recent` with
  `severity='info'` and no push delivery.
- [ ] **2.4** Seed a parked-question scenario: assistant turn ending
  with `?`, no user follow-up for >30 min. Wait one tick. Expect
  `parked_question_persistent` with `severity='alert'`; push
  notification fires (operator verifies phone buzz on subscribed
  device).

### Step 3 — Fix 49 codex 12 project_scope_id

Goal: scope-vs-label predicate wins consistently; PATCH operator
override audits.

- [ ] **3.1** Fresh brainstorm spawned via Lex bound to a project
  anchor. Query `SELECT project_scope_id FROM brainstorm_sessions
  WHERE id = '<bs>';`. Expect non-null = the supervises anchor id
  (auto-inherit at insert per codex 12c).
- [ ] **3.2** `PATCH /brainstorms/<id>/project-scope` body
  `{"project_scope_id": "manual-scope"}` returns 200 with
  `old_scope` set. `cross_session_injection_log` carries
  `caller_label='brainstorm-scope-patch'` row with JSON transition
  in `reject_reason`.
- [ ] **3.3** Cold-start preload on a Lex session bound to the
  scoped anchor: `/lex/cold-start-preload` block reads `# Sibling
  sessions (same project scope <id>)` not `(same label "X")`.

### Step 4 — Fix 50 PRELOAD-1 SessionStart hook stdout shape

Goal: cold-start preload + worker-handoff blocks land in CC's
`hook_additional_context` on the first user turn.

- [ ] **4.1** Fresh Lex CC SessionStart in a brainstorm with at least
  one prior sibling session. Read the live jsonl's first user-turn
  attachments; the DevNeural cold-start block must be present
  (alongside caveman / superpowers / deep-project blocks).
- [ ] **4.2** Fresh worker CC SessionStart bound to a project anchor.
  Same check against the worker-handoff block.

### Step 5 — Fix 51 cc-pty double-talk

Goal: pre-tool ack + end_turn body never overlap audibly. The fix
removes the `handle.done` early-release in `speakOne`.

- [ ] **5.1** Open voice on a Lex CC brainstorm. Ask a question that
  triggers a tool_use (e.g. "show me the latest commit"). Expect
  the pre-tool ack to finish speaking BEFORE the end_turn body
  starts. Zero audible overlap.
- [ ] **5.2** Tail daemon log during the same turn: `[voice-ws]
  tts-start` frames are NOT followed by a second `tts-start`
  inside the prior piper's lifetime (use the timestamps from the
  voice WS log).
- [ ] **5.3** Barge mid pre-tool ack: speak while ack is playing.
  Expect `tts-cancel` frame, PTY Ctrl+C, partialChain captures the
  cancelled segment.

## Tier 4 — Hardware-blocked / environment-gated

- [ ] **9.1 iOS PWA push end-to-end** (reminder-push.ts + daemon.ts).
  Setup: iOS device, dashboard installed as PWA. Action: subscribe
  to push, create reminder with trigger +1 min. Verify: device
  buzzes; `reminder_push_audit.delivery_status = 'delivered'`.
- [ ] **9.2 PANIC-BUTTON live press**. Deferred until throwaway
  worker is live. Confirm with user before pressing.
- [ ] **9.4 Mobile Safari OOM repeat-hit observation**. Window: 24h
  from any restart. Verify no repeat of OOM crash. If it
  reproduces, open Voice diagnostics → ring buffer → append to
  `docs/bugs/2026-05-16-voice-restart-oom-regression.md`.

## Tier 5 — Diagnosed-only, NOT smoke targets

Investigations in `docs/bugs/`; fixes not yet written:

- **Fix 24** mid-reply TTS truncation. Watchdog `ctx_state` gate.
- **Fix 25** mic input level + sensitivity sliders. Three root
  causes documented.
- **Fix 26** `Lex hold up` wake-phrase kills mic permanently.
  Asymmetric cancel path.
- **Voice PTY paste-no-commit regression** (Bug A,
  `docs/bugs/2026-05-29-voice-pty-paste-no-commit-regression.md`).
  Proposed fix: mirror Fix 32's 850ms bare-CR follow-up into the
  direct-inject path at `lex-voice-ws.ts:2147`.

## Not-built / future

- [ ] Auto-discover projects under `C:/dev/Projects` filtered by
  project-marker files.
- [ ] Phase 7 speaker diarization (pyannote).
- [ ] Phase 8 reliability plan (see `docs/spec/PHASE-8-RELIABILITY-
  PLAN.md`).
- [ ] Smart-clear rename (current `smart-compact` name misleads).
- [ ] Coalesce Phase B (classifier + conflict push-back +
  AbortController) per the sealed roadmap in
  `docs/spec/COALESCE-UTTERANCE-QUEUE.md`.

## Stop conditions

An item moves out of this doc when verified on real hardware and
folded into a HOW-TO or recorded under `FIXES.md`. An item moves to
Tier 5 only if a blocking condition (real iOS device, real third-
party session, throwaway worker) is not present.
