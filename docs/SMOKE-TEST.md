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
- [x] **1.4 (module probe, 2026-05-29)** Live `evaluateLooseEnds`
  against anchor `4bbafb48` returned `has_blocker=false,
  has_auto=true, ends=2` (`undistilled_ref` auto-info: 8 ended refs
  missing distillation; `stale_ref_beyond_T` informational: 24 refs
  stale). Module wired, detection correct. Live
  `caller_label='loose-ends-auto-resolve'` audit fire still needs a
  real `/clear-and-paste` invocation post-Fix-47 (0 rows so far —
  no spawn has tripped the wire since ship).

### Step 2 — Fix 48 codex 11 grooming watch

Goal: 30-min tick walks brainstorm anchors and surfaces six gap
classes through the notifications pipeline; alert severity reaches
push, info stays bell-only.

- [x] **2.1 PASS 2026-05-29** Daemon log:
  `[2026-05-29T16:11:29.685Z] grooming-watch: started` after
  cancelled-tool-recovery on the post-Fix-51 boot.
- [x] **2.2 PASS 2026-05-29** `GET /lex/grooming/recent?limit=5` →
  200 `{ok:true, rows:[]}`. Filter applied, no rows yet (no gap
  classes tripped — anchors healthy).
- [x] **2.3 (module probe, 2026-05-29)** Live `runGroomingTick`
  against the production DB returned `evaluated=0` because all 91
  brainstorms are `status='ended'`; `listBrainstorms({status:
  'active'})` correctly filters them out. Detector logic confirmed
  working; live `idle_no_distill` emit blocked on active anchor.
- [ ] **2.4** Seed a parked-question scenario: assistant turn ending
  with `?`, no user follow-up for >30 min. Wait one tick. Expect
  `parked_question_persistent` with `severity='alert'`; push
  notification fires (operator verifies phone buzz on subscribed
  device).

### Step 3 — Fix 49 codex 12 project_scope_id

Goal: scope-vs-label predicate wins consistently; PATCH operator
override audits.

- [x] **3.1 PASS 2026-05-29** Brainstorm `4bbafb48` carries
  `project_scope_id = 391b88f6-396c-4c46-a8d7-b656a2d5ad1d` (the
  DevNeural project anchor) per `GET /brainstorms/4bbafb48`. 1/91
  brainstorm rows scoped; correct — only `lex_session 4bbafb48`
  has `supervises_project_anchor_id` set.
- [x] **3.2 PASS 2026-05-29** `PATCH /brainstorms/4bbafb48/project-
  scope` body `{"project_scope_id": "391b88f6..."}` returned 200.
  `cross_session_injection_log` count of `caller_label=
  'brainstorm-scope-patch'` = 1.
- [ ] **3.3** Cold-start preload on a Lex session bound to the
  scoped anchor: `/lex/cold-start-preload` block reads `# Sibling
  sessions (same project scope <id>)` not `(same label "X")`.
  Live audit shows current production block uses the anchor-refs
  primary path (`# Prior Lex sessions on this anchor`); the scope-
  vs-label header only renders when label-match fallback fires
  (anchor with zero prior refs). Verification deferred to a fresh
  anchor with a scoped sibling pair.

### Step 4 — Fix 50 PRELOAD-1 SessionStart hook stdout shape

Goal: cold-start preload + worker-handoff blocks land in CC's
`hook_additional_context` on the first user turn.

- [x] **4.0 (dist verify, 2026-05-29)**
  `07-daemon/dist/capture/hooks/hook-runner.js` lines 173-180 +
  222-230: both `postColdStartPreload` and `postWorkerHandoff` wrap
  the route block in
  `JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext}})`.
  Cold-start preload route audit log: 104 rows under
  `caller_label='cold-start-preload'`, latest 2026-05-29 15:04Z
  (~2h before this verify), text_length=28924, decision='accepted'.
- [ ] **4.1** Fresh Lex CC SessionStart in a brainstorm with at least
  one prior sibling session. Read the live jsonl's first user-turn
  attachments; the DevNeural cold-start block must be present
  (alongside caveman / superpowers / deep-project blocks).
- [ ] **4.2** Fresh worker CC SessionStart bound to a project anchor.
  Same check against the worker-handoff block.

### Step 5 — Fix 51 cc-pty double-talk

Goal: pre-tool ack + end_turn body never overlap audibly. The fix
removes the `handle.done` early-release in `speakOne`.

- [x] **5.0 (dist + test verify, 2026-05-29)**
  `07-daemon/dist/voice/lex-voice-speak-controller.js` no longer
  contains `handle.done.then` (compiled Fix 51 confirmed). 7/7
  pins in `tests/lex-voice-ws-speak-queue.test.ts` pass including
  the new pin (5) that resolves `done` before pcm 'end' and
  asserts the queue does NOT advance until pcm ends.
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
