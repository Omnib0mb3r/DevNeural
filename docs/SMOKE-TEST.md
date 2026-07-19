# DevNeural Smoke Test Checklist

Live punch list of things shipped in code but not yet verified end-to-
end on real hardware. Refresh as items get verified or new code lands.
Source of truth for the daily smoke gate; rolling cursor for the rest
of the state lives in `docs/HANDOVER.md`.

Last refreshed: 2026-06-20 after all three pillars wired + committed and
the distill-scheduler tests fixed. Switch-live pending operator restart.
See ACTIVE BATCH below.

## PENDING RESTART VERIFY (2026-07-19): voice top-layer + bell + binding-terminal

Shipped, committed, full dist rebuilt (daemon tsc + dashboard next build).
Dormant until the operator restarts the daemon AND hard-refreshes the PWA.
Commits: voice `3768ec4`, bell `67dc213`, binding-terminal `ff5c167`.
Nothing below is hardware-verified.

- [ ] **Stream Deck nesting** (operator-flagged 2026-07-19): the worker
  tile nests UNDER its brainstorm tile AND stays nested across a daemon
  restart / worker restart / new session. No code changed here -
  StreamDeck.tsx already nests off `supervised_project_slug`; this is a
  pure smoke test that the anchor->worker binding
  (`project_session.current_session_id`) follows a restart. If it renders
  as two separate tiles after a restart, that stale binding is the bug to
  chase, not the nesting code.
- [ ] **Voice #1** slow / long turn: no "voice error", no session death,
  no clipped restart (the turn timeout no longer scores a liveness
  strike; conversational asks pass `noLivenessStrike`).
- [ ] **Voice #2** a mid-turn reply Lex makes before a tool call is spoken
  IN FULL, not cut after the first period (`clampAck` deleted; mid-turn
  now speaks like the end_turn body).
- [ ] **Voice #4** hold PTT while Lex would speak: ZERO audio over you
  (`state.pttFloorHeld` gates `speak()`; VAD energy alone does not).
- [ ] **Bell** dropdown shows ONLY actionable rows, no idle_prompt /
  "Worker stalled" / telemetry pileup (live query went 310 -> 14; confirm
  on the running notifications surface, and that a supervised worker going
  idle produces NO bell row).
- [ ] **Worker-terminal panel** shows no "streaming other session / check
  StreamDeck.App registered" false warning when a worker is bound (the
  stale bridge flush `0e98cc74` resolves to no project -> null -> no warn;
  verified against the live mirror-state, needs the daemon restart to
  serve `last_flush_project`). A genuine cross-project misroute must still
  warn.

## ACTIVE BATCH (2026-06-20): INVESTIGATOR-PIPELINE — cold-start, distillation, voice

The current program. Goal (Michael, 2026-06-19): **one system** with three
pillars — multi-agent cold start, distillation, separate-agent voice.
Design of record: `docs/spec/INVESTIGATOR-PIPELINE-SPEC.md` +
`C:/dev/data/skill-connections/brainstorm/INVESTIGATOR-PIPELINE-PLAN.md`.

Build status as of 2026-06-20 (HEAD `af6be39`, 1273 daemon tests green,
tsc clean; full suite verified green under BOTH `DEVNEURAL_DISTILL_HEADLESS`
unset AND `=1`, the switch-live env):

- **Pillar 1 cold start** wired: synchronous boot gate `gateColdStart` in
  spawn-lex-session.ts (replaced the fire-and-forget that wrote nothing);
  assembles + validates prior + persists a report + caches the seed
  before the SessionStart hook; crash recovery on boot. Reports RELOCATED
  to `<projectDir>/investigator-reports/<YYYY-MM-DD_HHmm-ss>.md` (+
  archive/), e.g. `C:/dev/Projects/DevNeural/investigator-reports/`.
- **Pillar 2 distillation** wired: staleness-driven re-distill on the
  unified headless-Opus engine, behind `DEVNEURAL_DISTILL_HEADLESS`
  (flipped ON in `07-daemon/scripts/start-daemon.ps1`). distill-scheduler
  tests now isolate that flag so the gate passes under the live env.
- **Pillar 3 voice** wired: haiku talk-layer (V1-V7) + live WS capstone
  (CAP-1 render+heartbeat, CAP-2 inbound lane routing) behind
  `DEVNEURAL_VOICE_HAIKU` (default OFF, flag-off byte-identical). Live
  haiku MODEL calls + Lex-authored digest push still deferred
  (BF-4 + latency fork); deterministic glue + safe-render in place.

Both engine flags are dormant until the operator rebuild+restart. Nothing
below is hardware-verified yet.

Verification bar (non-negotiable, per `feedback_verify_outcome_metric_not_green_tests`):
a pillar passes only when the **real metric moves on live hardware**, not
when tests are green. Green + committed is "built", not "verified".

### Step 0: Prep (Michael does on reset)

- [ ] **0.1** Rebuild daemon. `cd C:/dev/Projects/DevNeural/07-daemon && npm run build`.
- [ ] **0.2** Restart daemon (operator-only; restart kills the live Lex
  session). Use the dashboard restart or `start-daemon.ps1 -Force`.
- [ ] **0.3** Confirm flag is live: daemon log shows
  `[distill-scheduler] headless Opus engine (DEVNEURAL_DISTILL_HEADLESS=1)`.
  If it does NOT, the env didn't inherit — fix before judging distillation.

### Pillar 1 — Multi-agent cold start (BUILT, verify on reset)

Ephemeral headless investigator assembles + validates context, persists a
timestamped report per anchor, seeds Lex; same engine handles crash recovery.

- [ ] **1.1** After reset, Start Voice on the "DevNeural Testing" anchor
  (`4bbafb48`). A fresh dated report file is written under the PROJECT
  folder `C:/dev/Projects/DevNeural/investigator-reports/` (filename
  `YYYY-MM-DD_HHmm-ss.md`), newest-wins; older reports move to
  `investigator-reports/archive/` (never deleted).
- [ ] **1.2** Lex's first greeting is demonstrably CURRENT without being
  told: names the live state (all three pillars wired, HEAD `af6be39`) and
  the open item (engine flags dormant pending this restart; live haiku
  model + Lex digest still deferred). Pass = greeting proves it's caught
  up. (Feel-test: LLM-judge or Michael spot-check, FLAGGED as judgment,
  not a deterministic green.)
- [ ] **1.3** Crash recovery: kill the daemon mid-session (no clean
  end-of-session pass), restart. Investigator detects entries-after-last-
  distill and backfills the docs for the gap. Pass = the gap turns is
  reflected in the report/handover after restart, no manual prompt.

### Pillar 2 — Distillation (BUILT, flag now ON, verify on reset)

Staleness-triggered re-distill on the unified headless-Opus engine, one
writer / one staleness signal (`latest_chunk_ms > ref_summary_ms`).

- [ ] **2.1 INAUGURAL ACCEPTANCE TEST** — after reset with the flag live,
  run `node C:/tmp/stale-check.js` (or query `index.db` `lex_transcript_ref`).
  Pass = **stale ref count == 0** AND `ref_summary_ms >= latest_chunk_ms`
  on the live DevNeural Testing anchor, under the LIVE scheduled path (not
  a one-off backfill). This is the test that was always missing.
- [ ] **2.2** Trigger end-of-session on a brainstorm; confirm the critical
  end-of-session distill ran through the shared headless engine (daemon log
  + the wiki_drafts row it feeds), not ollama. Output is coherent, not garbage.
  (Risk note: this routes the MOST critical distill path onto the newly-live
  engine; if output is bad, roll back by deleting the env line in start-daemon.ps1.)

### Pillar 3 — Separate-agent voice (WIRED behind a flag, verify on reset)

**BUILT + committed**, dormant behind `DEVNEURAL_VOICE_HAIKU` (default OFF;
flag-off is byte-identical to current voice). Modules V1-V7 (single-mouth
lock, control channel, deny-by-default whitelist, two-lane router,
renderer + verbatim preserve-list, folded heartbeat, persona + digest +
front desk) + live WS capstone (CAP-1 render/heartbeat, CAP-2 inbound lane
routing in lex-voice-ws.ts). DEFERRED: live haiku MODEL calls + Lex-authored
digest push (BF-4 + latency fork); deterministic glue + safe-render run for
now. Module-level tests cover 3.1-3.5; hardware verify needs the flag ON.

- [ ] **3.1** Single mouth: haiku owns ALL spoken output; two TTS streams
  are structurally impossible (no double-talk under any stack-up).
- [ ] **3.2** Two lanes: fast lane (haiku-only conversational glue, zero
  Opus round-trip) vs slow lane (haiku bridging line, Lex reasons, haiku
  speaks result). Measured latency gap between the two.
- [ ] **3.3** Deny-by-default whitelist: haiku answers alone ONLY for
  conversational glue (ack, repeat, slower/louder, yes-no about last line);
  ANY project/code/state fact queues to Lex. Probe: feed a state question,
  assert it queued, not answered by haiku.
- [ ] **3.4** Renderer-not-rethinker: numbers / decisions / negations /
  blockers passed through verbatim (preserve-list), never reworded.
- [ ] **3.5** Control channel: stop / quiet / abort / redirect recognized
  instantly by haiku, NEVER queued; "quiet" kills TTS locally with zero
  Lex round-trip. NOTE: flip `DEVNEURAL_VOICE_HAIKU=1` to exercise 3.1-3.5
  live; it is OFF by default so this restart does not change voice.



## Cycle cursor (2026-06-01)

Most-recent ship cycle covered Fix 52 through Fix 60 (project anchor
seeding, cold-start distillation recovery + verdict surfacing,
COALESCE Phase B + C, TTS sanitizer, distillation dump helper).

Module-side + API-side smoke is **GREEN** across the cycle. Live
hardware verification is the remaining gate. Highest-leverage live
step right now is **6.7** (live brainstorm spawn + Lex first-reply
vetting against the Fix 55 verdict envelope); it closes the loop on
the four-fix cold-start chain (52, 53, 54, 55).

Module probes already passed for the new cycle:

- `POST /lex/cold-start-preload` against the bound 4bbafb48
  brainstorm returned `context_verdict=partial last_child=DevNeural
  Testing distillation_gap_ms=0` plus 5 sibling distillation
  summaries inline (verifies Fix 52, 53, 54, 55 all live).
- `[distill-scheduler:boot-recovery] processed=0 errors=0
  skipped=11 hit_cap=false` on the post-Fix-57 boot (verifies the
  Fix 53 boot recovery sweep fires correctly; remaining 11 rows are
  dead data per audit).
- `[distill-backfill] 37 chunkless brainstorms eligible via jsonl
  fallback` and per-row `[distill-gen] using jsonl-fallback` lines
  earlier in the cycle (verifies Fix 54 jsonl-fallback path).
- 1123/1123 daemon tests pass after Fix 60 (was 1063 pre-cycle).
- 138/138 dashboard unit tests pass.
- `npm run dump-distillations -- --limit 5` wrote a clean markdown
  file with 5 rows (verifies Fix 60).

## Recovering this checklist in a fresh Lex session

If the active CC Lex session ends mid-smoke (crash, /clear, restart),
the task panel disappears. To rebuild:

> Tell Lex: **"rebuild smoke task list from SMOKE-TEST.md"**

Lex reads this file, recreates every `[ ]` item as a task, preserves
`[x]` marks, and resumes from wherever it was. The Markdown file is
the source of truth; the task panel is just the live view.

## ACTIVE BATCH (2026-05-29): LEX-AUTONOMY codex 10/11/12 + PRELOAD-1 + cc-pty double-talk

Gate: all green required before the next ship cycle opens. Each step
below has a daemon-side check that runs from any shell + an operator-
side check that needs voice or a phone in hand.

### Step 0: Prep (one-time, before any test below)

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

### Step 1: Fix 47 codex 10 loose-ends gate

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
  real `/clear-and-paste` invocation post-Fix-47 (0 rows so far;
  no spawn has tripped the wire since ship).

### Step 2: Fix 48 codex 11 grooming watch

Goal: 30-min tick walks brainstorm anchors and surfaces six gap
classes through the notifications pipeline; alert severity reaches
push, info stays bell-only.

- [x] **2.1 PASS 2026-05-29** Daemon log:
  `[2026-05-29T16:11:29.685Z] grooming-watch: started` after
  cancelled-tool-recovery on the post-Fix-51 boot.
- [x] **2.2 PASS 2026-05-29** `GET /lex/grooming/recent?limit=5` →
  200 `{ok:true, rows:[]}`. Filter applied, no rows yet (no gap
  classes tripped; anchors healthy).
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

### Step 3: Fix 49 codex 12 project_scope_id

Goal: scope-vs-label predicate wins consistently; PATCH operator
override audits.

- [x] **3.1 PASS 2026-05-29** Brainstorm `4bbafb48` carries
  `project_scope_id = 391b88f6-396c-4c46-a8d7-b656a2d5ad1d` (the
  DevNeural project anchor) per `GET /brainstorms/4bbafb48`. 1/91
  brainstorm rows scoped; correct: only `lex_session 4bbafb48`
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

### Step 4: Fix 50 PRELOAD-1 SessionStart hook stdout shape

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

### Step 5: Fix 51 cc-pty double-talk

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

### Step 6: Project anchors seeding + presence auto-create (2026-05-31)

Goal: every top-level dir under `C:/dev/Projects` exists as a
`project_session` row at daemon boot; an unknown-cwd bridge presence
auto-creates its anchor instead of getting silently dropped. Closes
`docs/bugs/2026-05-31-project-anchors-not-seeded-silent-drop.md`
("new projects showing up but production code never finished"; spec
section `## Seeding` at `docs/spec/PROJECT-ANCHORS.md:57`).

- [ ] **6.1** Fresh daemon boot with empty `project_session` table:
  `seedProjectAnchors` enumerates every top-level dir under
  `DEVNEURAL_PROJECTS_ROOT` (default `C:/dev/Projects`) and upserts
  one row per dir. SELECT count(*) FROM project_session matches `ls
  C:/dev/Projects | wc -l` (minus dotfiles and non-dirs).
- [ ] **6.2** Re-run boot. No duplicate rows; same count. Idempotent.
- [ ] **6.3** `mkdir C:/dev/Projects/__smoke_seed_test__` while daemon
  running. Within `fs.watch` debounce window: a row appears for the
  new dir. `rm -rf` the dir; the row stays (spec rule: explicit user
  delete only).
- [ ] **6.4** Drop a fake bridge presence file under an unseeded cwd
  (or remove the anchor row and let bridge re-announce). On next
  reconcile pass, `bridge-presence.ts` creates the anchor inline AND
  flips it `status='live'` in the same pass. No silent drop.
- [ ] **6.5** Dashboard /system Projects panel renders every disk dir
  exactly once. No phantom / duplicate / missing tiles.
- [x] **6.6 PASS 2026-05-31** Cold-start preload distillation gap.
  Closed by Fix 53 (boot recovery sweep + partial verdict
  promotion), Fix 54 (jsonl-fallback distillation), Fix 55
  (context_verdict + last_child surface + Lex vetting protocol).
  Live API probe `POST /lex/cold-start-preload {session_id:
  '332e6e5b...'}` returned block with `context_verdict=partial
  last_child=DevNeural Testing child_ended_ms=1780249008862
  distillation_gap_ms=0` and 5 sibling distillation summaries
  inline. Daemon log post-Fix-54 boot showed
  `[distill-backfill] 37 chunkless brainstorms eligible via jsonl
  fallback` and per-row `[distill-gen] using jsonl-fallback`
  lines. 11 remaining unrecoverable rows are dead data (chunks=0
  AND transcript_path missing on disk; see audit in
  `docs/bugs/2026-05-31-project-anchors-not-seeded-silent-drop.md`).
  Catchup ceiling raised in Fix 56 (`syncMaxRefs` 3 -> 6,
  `syncBudgetMs` 5000 -> 8000).
- [ ] **6.7** Live brainstorm spawn + Lex first-reply vetting.
  Open a fresh Lex session against a brainstorm with at least one
  prior child session; confirm Lex's first turn quotes the verdict
  honestly (fresh -> brief continuity ack; stale -> "distillation
  is a couple of hours behind" caveat; outdated/empty -> asks
  Michael to fill in). Hardware-gated; verify on next live
  brainstorm.

## Tier 4: Hardware-blocked / environment-gated

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

## Tier 5: Diagnosed-only, NOT smoke targets

Investigations in `docs/bugs/`; fixes not yet written. All four
remain open as of 2026-06-01:

- **Fix 24** mid-reply TTS truncation. Watchdog `ctx_state` gate.
- **Fix 25** mic input level + sensitivity sliders. Three root
  causes documented.
- **Fix 26** `Lex hold up` wake-phrase kills mic permanently.
  Asymmetric cancel path.
- **Voice PTY paste-no-commit regression**
  (`docs/bugs/2026-05-29-voice-pty-paste-no-commit-regression.md`).
  Proposed fix: mirror Fix 32's 850ms bare-CR follow-up into the
  direct-inject path at `lex-voice-ws.ts:2147`.

## Not-built / future

- [ ] Auto-discover projects under `C:/dev/Projects` filtered by
  project-marker files. (Fix 52 lands raw top-level enumeration;
  the marker-file filter is a follow-up.)
- [ ] Phase 7 speaker diarization (pyannote).
- [ ] Phase 8 reliability plan (see `docs/spec/PHASE-8-RELIABILITY-
  PLAN.md`).
- [ ] Smart-clear rename (current `smart-compact` name misleads).
- [x] **Coalesce Phase B + C shipped 2026-06-01 (Fix 57).**
  Classifier, conflict push-back via passed rule set, AbortController
  on contradiction, text-input WS frame, all live.
- [ ] WASM/VAD OOM follow-ups: (b) COOP/COEP headers to unlock
  SharedArrayBuffer; (d) singleton ORT init so VAD remount reuses
  the existing WASM module. Hardware repro needed before tuning.

## Stop conditions

An item moves out of this doc when verified on real hardware and
folded into a HOW-TO or recorded under `FIXES.md`. An item moves to
Tier 5 only if a blocking condition (real iOS device, real third-
party session, throwaway worker) is not present.
