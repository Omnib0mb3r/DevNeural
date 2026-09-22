# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update.

## Cursor (2026-09-22 12:20 local, voice layers wave on branch `voice-layers`; daemon on the branch dist; first voice test done: L1 works, BRAIN UNREACHABLE (BUG-026); items 5-8 blocked)

Built overnight 2026-09-21/22 on operator direction ("just build it, I'll
test in the AM"). Everything is committed on branch **`voice-layers`**
(master untouched past `6b12951`); `07-daemon/dist` and
`08-dashboard/out/` are rebuilt from the branch. ONE operator daemon
restart deploys it. Merge to master after the live verify (`git merge
voice-layers` from master, or keep testing on the branch).

Fresh-context resume seed (what landed, the reset, the checklist, the file
map, in one file): `C:\dev\data\skill-connections\brainstorm\HANDOVER-2026-09-22-voice-layers.md`.

Design of record: `docs/spec/LAYER-1-CONTROL.md` (v2, canonical). Plan:
`docs/superpowers/plans/2026-09-21-voice-layers.md`. Trackers: BUG-022
(chars=0 root cause, SMOKE-TESTING), BUG-023 (pre-existing dashboard test
red), FIXES.md rows VL-1..VL-9.

### 2026-09-22 morning: restart done, item 1 verified (operator said "do it")

- Restart fired `POST /admin/daemon/restart` at 14:23:40Z. Graceful
  shutdown 3.3s (`[shutdown] complete`), new PID 24256 listening at
  14:23:46Z, `migrations: applied 1 (054-lex-session-voice-binding.sql);
  total=55`. The running daemon is now the branch dist (00:38).
- Item 1 PASSED on `POST /lex/anchors/4bbafb48.../open` (DevNeural
  Testing): `[voice-brain] anchor=4bbafb48 spawned ptyId=524b8e5f...` at
  14:24:47.851Z, `[lex-anchor] reopen` at 14:24:47.989Z (L1 first), `warm:
  first reply after 6942ms`. L2 cc=42fb8c7f pty=a03c7122 is up for the
  operator. Items 2-9 need a human voice; nothing else was verified.
- Branch event to know about: at 10:14:35 local an untracked `AGENTS.md`
  (Codex-flavored copy of CLAUDE.md) appeared and at 10:14:43 something
  ran `git checkout master` in this tree (reflog). Not this session; a
  codex sandbox service was running. The tree was switched back to
  `voice-layers` at ~10:22 with the guard "no tracked changes, last reflog
  entry is that checkout". `AGENTS.md` is left untracked and untouched.
  Trap: an `npm run build` while on master would replace the branch dist.
- BUG-024 logged (project anchor seed pass aborts every boot on the
  `Resume` slug collision; two months old, unrelated to the wave).
- BUG-025 logged: `[wiki-push] push failed` every 300s since 2026-08-02
  because a wiki page grew to 134 MB by frontmatter single-quote doubling
  (`escapeScalar` doubles, `parseScalar` never undoubles); the four
  unpushed wiki commits carry it and GitHub rejects files over 100 MB.
  Fix recipe in the entry; the local history rewrite is the operator's call.
- L2 after Open sits with an empty composer and no jsonl until the first
  voice forward. Claude Code is fine with that; the daemon is not (see
  BUG-026 below: it calls that state "warming" forever).

### 2026-09-22 12:13-12:16 local: first operator voice test (five utterances)

- PASSED: item 2 (L1 answered within 2-3s of each utterance), item 4
  ("Can you see what the worker's doing?" answered from the live block:
  worker live on DevNeural), BUG-022 -> RESOLVED (5/5 asks chars 44-369,
  no chars=0, no raw fallback).
- FAILED: nothing reached L2. Every turn logged `[voice-ws] L1 turn:
  speech=true forward=false control=none ignore=no warming=true`. L2 had
  been up 110 min. Root cause BUG-026: `_midStateImpl` says warming until
  the L2 jsonl has an assistant record, the jsonl only appears after L2's
  first turn, and forwards are parked while warming. Circular. Items 5-8
  cannot pass until that is fixed. Fix sketch in the bug (warm from the
  PTY, or the daemon sends the greeting turn on Open).
- Also found: BUG-027 (a second `anchor=default` L1 spawns on every voice
  attach; three claude.exe now) and BUG-028 (L1 answered "What is your
  goal?" by reciting the operator's MEMORY.md; Claude Code loads the
  git-root auto-memory for the L1 cwd `07-daemon`). Fix sketches in the
  bugs. Not exercised: items 3, 6, 7, 8, 9.
- 12:18-12:20 local, five more utterances: BUG-029 (L1 said the worker
  was "idle, no active brainstorm" while `/sessions` said `thinking`; the
  live block only carries `live (<slug>)`, no phase, so haiku guessed) and
  BUG-030 ("Lex mute." -> spoken "Muted." with `control=none`, mic stayed
  live; "just stop" -> `control=none`; "(Listening, not speaking.)" was
  spoken aloud). Only "lex emergency stop" is deterministic today. Treat
  voice mute as NOT working until BUG-030 is fixed.
- Operator observation that started this: "she said the worker is idle,
  and clearly you are not idle". Correct. L1 invented it; the daemon knew.
- The brainstorm still has no supervised project anchor
  (`supervises_project_anchor_id` null, all 8 brainstorms likely the
  same), so the deck shows the DevNeural worker as unsupervised. Bind
  with `PATCH /lex/anchors/:id {"supervises_project_anchor_id":
  "6c7d6691-8e72-427a-9e95-8a70161e4d34"}` or the dashboard picker, then
  reopen so the scope reaches L2's prompt.
- Next: fix BUG-026 first (it gates everything downstream), then BUG-028,
  then BUG-027; rebuild; restart; rerun items 2-9.

### What shipped (branch commits, oldest first)

- `0d056e1` carry-over of the 2026-08-26 session's uncommitted fixes (as found).
- `6b12951` docs: LAYER-1-CONTROL v2 + the plan.
- `670c7cd` BUG-022 root cause: Claude Code writes a thinking-only record
  already stamped `end_turn` BEFORE the text record; `waitForVoiceReply`
  closed the ask on it, so every L1 ask was `chars=0`. Grace window for the
  sibling text record.
- `b12fa91` shared persona module (one Lex, two mouths).
- `9b33f1d` knobs `top_model`, `top_effort`, `mid_effort`, `worker_effort`,
  `dispatch_confirm_gate`; L1 spawns with `--setting-sources project,local`
  (headless haiku spawn 30-57s -> 4s, measured).
- `720a1e7` one L1 per brainstorm anchor, spawned on Open BEFORE L2,
  binding persisted (migration 054), killed with the anchor.
- `cadb7cb` Layer 1 prompt (sparring partner contract), live block,
  FORWARD / CONTROL / IGNORE parser, streaming turn, fail-safe forward.
- `3f279c8` Layer 1 wired into the turn pipeline (speak / forward /
  control / ignore, warm queue, brain-progress, single-mouth guards).
- `b7e9e23` blue/green L1 respawn past the jsonl cap.
- `17ea3a5` Phase B: dispatch confirm gate + plan approval by voice.
- `e296252` trackers + SMART-COMPACT.md rewritten as the context-lifecycle doc.
- dashboard: greyed "(not for Lex)" rows for dropped utterances.

### Late addendum (2026-09-22 ~01:00, /goal "native-fast, one seamless Lex")

- **Fast:** the L1 session now spawns with `MAX_THINKING_TOKENS=0`.
  Measured with `claude -p --model haiku`: default 154 thinking tokens,
  3.0s API time, 2.2s to first token for one spoken sentence; thinking off:
  0 tokens, 0.64s, 0.66s, identical sentence. Override
  `DEVNEURAL_VOICE_BRAIN_THINKING_TOKENS`.
- **Seamless:** out loud there is one Lex. The L1 contract and the spoken
  rules now forbid the words brain / layer / top / mid / session / model /
  deeper reasoning; the delivery cue is "right, got it", never "the brain
  is back". The transcript labels every assistant line `lex:` (was
  "lex (voice):" / "lex (brain):"), renders the brain's reply as a normal
  row (the collapsed "brain replied" toggle is gone), and the internal
  "to Lex (brain): ..." hop line is no longer sent; the routing is in
  `daemon.log` as `[voice-ws] forward to L2: ...`. `data-layer` stays on
  the rows for debugging.
- Verify items 3 and 5 below read accordingly: no "brain replied" toggle,
  the answer text is simply the next `lex:` row.

### Verified running state at handover

- Daemon PID 32924 (booted 2026-09-21 ~22:11 local) still runs the OLD
  dist; it has none of the above. `dist/` rebuilt 2026-09-22 00:26 local
  from the branch; `out/` rebuilt right after (see the last commit).
- Full daemon suite on the branch: 2156 passed, 2 failed, both pre-existing
  (`grooming-routes` = BUG-014; `sessions-anchor-liveness` red also with
  the pre-wave `sessions.ts`, verified by swapping the file in).
- Dashboard suite: 299 passed; 3 failing files are the 2 Playwright
  collection errors + `voice-mic-init.test.tsx` (BUG-023, pre-existing).
- Ports / Tailscale / Salem road trip: untouched (no command bound a port
  or restarted anything).

### Restart-verify (morning checklist, in order)

1. Restart the daemon (dashboard restart button or the scheduled task).
   `daemon.log` should show `[voice-brain] anchor=<id8> spawned ptyId=...`
   on the next brainstorm Open, BEFORE the `[lex-anchor] new anchor` /
   `reopen` line, and `warm: first reply after <N>ms` with N in the
   single-digit seconds.
2. Open a brainstorm, press Start voice, talk immediately: the voice pill
   goes live on L1 warm; if L2 is still booting, Lex says the deeper part
   is still waking up and the forward lands once it warms
   (`[voice-ws] L2 warming; queued forward` then `L2 warm; flushing`).
3. Say something to the TV / another person: transcript shows it greyed
   "(not for Lex)", `daemon.log` has `[voice-ws] L1 ignored (<reason>)`,
   nothing reaches L2.
4. Ask "what's she doing" while L2 is mid-turn: L1 answers with the live
   state; L2 keeps working. After ~45s of silence during a long turn L1
   may say a word (`brain-progress`), or nothing.
5. L2 reply is spoken in L1's voice: `[voice-brain] ... ask replied ...
   chars=<n>0` (NOT 0) and no `speaking raw body` fallback line. That is
   BUG-022 -> RESOLVED.
6. Barge over a reply: audio stops, never resumes, text intact. Say a
   correction: `[voice-ws] L1 drop_reply` or `cancel_redirect: double-ESC
   sent to L2`.
7. Arm the gate: `POST /runtime-config/dispatch_confirm_gate {"value":"on"}`.
   Ask Lex to send the worker something: `[dispatch-gate] parked <id>`,
   L1 asks you; "go" -> `[dispatch-gate] released <id>: status=200
   decision=accepted`; "no, X" -> the brain gets `[dispatch-rejected]`.
8. Only after 1-7 pass: `POST /runtime-config/mid_permission_mode
   {"value":"plan"}`, reopen the brainstorm, ask for a plan: L1 reads it
   out (`[plan-approval] pending on anchor`), "go" presses Enter on L2,
   "no, X" presses Escape + types the reason. If plan mode misbehaves,
   flip back to `bypassPermissions` (live, no rebuild).
9. `lex emergency stop` still fires with no model in the loop.
10. Then merge `voice-layers` into master.

Every log line above is pre-wired; grep `daemon.log` first on any failure.
Knob reference: LAYER-1-CONTROL.md "Knobs".

### Next after the live verify

- Phase C (worker-authored handover + Lex review, T3): recipe in
  `docs/spec/SMART-COMPACT.md` section 5; plan it as its own file.
- Two follow-ups noted during the build: the `ignored` frame's `reason` is
  not surfaced client-side (a tooltip would do); L2 could also boot faster
  with a trimmed `--settings` carrying only the daemon's hooks (not done:
  the capture hooks live in the user settings file).

## Previous cursor (2026-07-26, worker-linking + trust-gate + Stream Deck batch; daemon NOT restarted - PENDING operator restart)

CRITICAL: a backlog of committed-but-undeployed daemon fixes has stacked
up. The RUNNING daemon predates BOTH the 2026-07-19 batch (4 commits,
listed further below) AND today's 2026-07-26 commits. `npm run build` is
already done (dist fresh); ONE operator daemon restart deploys everything
at once. The daemon runs compiled dist, so a restart is required to
activate. Restarting recycles the Lex CC session (this conversation), so
it was deferred until the work was committed - it now is.

### Verified running state (2026-07-26 14:44, checked against the live process, NOT docs)

- Running daemon: PID 3932, started 2026-07-24 13:07, and NOT cycled since (a
  real daemon restart kills the Lex CC session; Lex stayed alive on the same
  PID across this whole session). Operator "resets" in this window did not
  cycle the daemon process.
- Current compiled dist: rebuilt 2026-07-26 14:38 (this session). It carries
  925eecb + today's 72b332b/27a3546. The running 7/24 daemon is on OLDER dist
  and does NOT have them. restart != rebuild: prior restarts reloaded stale
  dist because `npm run build` was never run after the source landed.
- Net: ONE genuine daemon restart now deploys everything (dist is fresh).

### Planned into the cold-start layers: make every session verify running state

Recurring failure this session: sessions (Lex included) asserted deploy /
"fixed-in-prod" state from handover/bug/memory notes instead of checking the
live process + dist mtime + git HEAD, and chased wrong root causes. Fix
belongs in the cold-start / smart-compact layers (`docs/spec/SMART-COMPACT.md`,
which already extends `live_state`): add a `live_state` **deploy-delta** line =
daemon PID + start time, newest dist mtime, git HEAD + commits-behind, injected
every session so staleness is pushed, not remembered. Backup rule saved as
memory `feedback_verify_live_deploy_state`.

### 2026-07-26 commits (newest first, on master, daemon builds clean)

- `27a3546` Keep a bound-but-idle bridge worker on the Stream Deck (trust
  the live anchor). New shared `liveAnchorSessionIds()` in `sessions.ts`;
  `listSessions()` + `GET /sessions` now keep a bridge worker visible while
  idle when its `project_session` anchor is live (bridge-backed). Fixes the
  worker vanishing from the Stream Deck on a VS Code reload though it was
  still running and bound (linking layer was fine; the DISPLAY liveness
  ignored the anchor). Bug: `docs/bugs/2026-07-26-worker-drops-off-streamdeck-when-idle.md`.
  Test: `live-anchor-session-ids`. DAEMON.
- `7303b9c` docs: trust-gate tracker status.
- `72b332b` Pre-seed Claude trust gate so Start Claude is one-click on new
  folders. `seedProjectTrust` in `queueProjectBootstrap` writes
  `~/.claude.json` `hasTrustDialogAccepted` before the first spawn, so a
  brand-new folder no longer parks at Claude's "trust this folder?" prompt.
  Bug: `docs/bugs/2026-07-26-start-claude-blocked-by-trust-prompt.md`.
  Test: `project-trust-seed`. DAEMON.

### Open work / do NOT reinvent

- **P3 (typed-to-Lex transcript): ALREADY FIXED, undeployed.** The operator
  wants a typed turn (their message AND Lex's reply) to render in the
  Lex-tab transcript above the talk-to-Lex box, like voice does. Commit
  `925eecb` ("render typed-input Lex replies in the transcript",
  2026-07-19 batch below) is exactly this. It is committed but the running
  daemon predates it. DO NOT re-implement - the pending restart activates
  it. Verify after restart.
- **Worker mirror blank (Problem 2): MIGRATED + INSTALLED this session; pending operator validation.**
  Root cause CONFIRMED (VS Code 1.130 removed the `terminalDataWriteEvent`
  proposed API). Migrated `09-bridge/src/extension.ts` capture onto the
  FINALIZED shell-integration API `window.onDidStartTerminalShellExecution` +
  `TerminalShellExecution.read()` (read() yields raw bytes incl. escape
  sequences, so it streams the claude TUI, verified against @types/vscode 1.118
  + context7). Downstream flush → daemon terminal-stream → dashboard unchanged.
  `enabledApiProposals` dropped (API is finalized), engines bumped `^1.93.0`.
  Built + packaged VSIX + `code --install-extension --force`; installed dist
  verified (5 new-API refs, old only in a comment). **TO VALIDATE (operator):
  reload the worker's VS Code window, THEN start/restart `claude` in the worker
  terminal** — `read()` only attaches to an execution that STARTS after the
  extension is active, so an already-running claude is NOT captured (the #1
  "looks broken but isn't" trap). Also needs VS Code shell integration active in
  that terminal (pwsh/bash/zsh/gitbash yes; cmd.exe no). The old
  `--enable-proposed-api` argv.json entry is now obsolete/harmless. Detail:
  `docs/bugs/2026-07-26-worker-mirror-blank-bridge-terminal-data.md`.

### Next after the worker stuff is verified OK

Build the two specs in `docs/spec/`: **`SMART-COMPACT.md`** (cold-start / smart
worker context refresh) and **`LAYER-1-CONTROL.md`** (layer-1 control). These
also carry the `live_state` deploy-delta / session self-verification work noted
above. Gate: do this once the worker linking + mirror are confirmed good on live
hardware.

### dropship-01 (this session's product work)

- New DevNeural worker project scaffolded from the dev-template GitHub repo,
  pushed to `github.com/Omnib0mb3r/dropship-01` (private, first commit
  `501283b`). Concept: fully-automated, AI-driven dropshipping store,
  target ~$1k/mo per store on ~20 min/day oversight, maybe 2-3 stores.
- A deep-research brief (supplier model, payment/ad ban risk, niche margin,
  automatable-vs-human loop, unit economics → write to
  `docs/research/dropship-viability.md`) was injected into worker session
  `c79dfeb9` and it began a 5-phase research workflow, but a VS Code reload
  KILLED that session mid-research. AFTER RESTART: re-inject the research
  brief into the fresh dropship-01 worker. Brainstorm `0d5c1ca8` supervises
  project anchor `b28a42d3` (dropship-01).

### Post-restart verify checklist

1. Trust gate (`72b332b`): Start Claude on a fresh scaffolded folder →
   live session, zero keypresses.
2. Stream Deck linking (`27a3546`): reload the dropship-01 VS Code window →
   worker stays on the Stream Deck and stays bound to brainstorm `0d5c1ca8`.
3. Typed transcript (`925eecb`): type to Lex (not voice) → your message and
   Lex's reply both render in the Lex-tab transcript.
4. Re-inject the dropship-01 research brief.

### Config change outside this repo

- `~/.claude/CLAUDE.md` gained a "Starting a New Project" section (canonical
  template = `github.com/Omnib0mb3r/dev-template`; 5-step scaffold). Mirrored
  in auto-memory `reference_devneural_project_template`.

### 2026-07-19 batch commits (still undeployed; deploy with the SAME restart)

- `63641c0` fix(notifications): keep telemetry sources off the
  input-needed bell. The bell surfaced background telemetry as if it were
  user notifications. Verified against the live notifications.jsonl: the
  real leak is grooming/housekeeping (source `grooming-watch`) at
  signal@alert riding the generic emergency lane (39 live rows). New
  `TELEMETRY_SOURCES` set (grooming-watch, curator, reinforcement) gated
  in `passesSurfaceFilter`: those sources never bell regardless of
  class/severity; they stay on the activity surface. idle_prompt (source
  `permission`, followup) still bells. DAEMON. Test:
  notifications-class-filter (grooming@alert dropped, daemon-down@alert
  still passes).
- `925eecb` fix(voice): render typed-input Lex replies in the transcript.
  FIXES the prior cursor's open-defect #1 ("typed-only shows the
  question, never the answer"). The transcript panel renders from live
  `assistant-text` WS frames, not a brainstorm_chunks poll; the
  direct-llm reply path delivered the reply ONLY through `speak()`, so a
  typed turn (suppressSpeakForTurn) persisted the reply but never emitted
  assistant-text and was invisible. New pure `planDirectLlmReplyDelivery`
  decouples render from TTS: assistant-text (layer 'mid') now fires before
  the TTS gate for every turn. Typed renders + silent; voice renders +
  spoken. DAEMON. Test: voice-direct-llm-delivery.
- `4da9157` fix(wire): one authoritative
  worker<->anchor<->brainstorm<->session binding. Four symptoms, one root:
  `project_session.current_session_id` (the single anchor->worker binding
  every surface reads) was populated and reaped inconsistently. (a)
  reconcileBridgePresence ranks the authoritative newest-active-jsonl
  signal above the bridge's ccSessionIds order for multi-claim windows, so
  a retired sibling can no longer be pinned as the live worker (the
  dispatch redirect is no longer load-bearing). (b) worker/Lex terminal
  mirror label reads the page's authoritative anchor->project binding via
  a projectSlug prop, killing "WATCHING UNKNOWN PROJECT". (c)
  readLiveSessionIds subtracts any live anchor's previous_session_id, so a
  replaced session cannot linger as a phantom "no brainstorm" worker card.
  (d) POST /sessions/:id/terminal-stream resolves the producer key through
  the same resolveMirrorSessionId the subscribers use, so bridge frames
  fill the ring the worker mirror watches (blank mirror now paints).
  DAEMON + DASHBOARD. Tests: bridge-presence, sessions-anchor-liveness,
  cross-session-resolve, curator-feed-labels.
- `61da1b0` fix(voice): barge kill emits tts-cancel off client playback,
  not synth ctx. Barge detection fired ("barge word-gate FIRED") but
  audio never stopped: killActiveTts only sent the client tts-cancel when
  speakCtrl.killActive() returned true, which is false whenever
  state.ttsActive is null, and a real barge interrupts CLIENT-buffered
  playback that outlives the daemon synth ctx. New `_killActiveTtsDecision`
  emits tts-cancel whenever cancelled OR clientPlaybackActive; the
  destructive parts (bargeStash / PTY Ctrl+C) stay gated on a real
  cancellation so a phantom barge never hard-interrupts the worker.
  DAEMON. Test: voice-barge-kill.

Builds on the earlier 2026-07-19 voice/bell/binding batch already on
master (ff5c167 worker-terminal mismatch, 465c21e inject-delivery
pill / brain-hop label, 78059c0 brain-replied label, 002833e smoke doc,
2e4ac40 client auto-reload).

### Deployed vs pending

- DAEMON (dist built, tsc clean): all four fixes are in the built dist;
  the RUNNING daemon predates them. One operator restart activates them.
  Every commit body ends `Rebuild: yes`.
- CLIENT (`08-dashboard/out/`, gitignored): ALREADY CURRENT, no build
  step before deploy. A fresh `next build` this session changed ONLY the
  build-id-derived HTML/txt and the sw.js/version.json timestamp stamp;
  ZERO `_next/static/chunks` changes, i.e. the compiled bundles were
  byte-identical, so out/ already contained the wire commit's label +
  mirror changes (built during the earlier wire verification). Served
  per-request; no restart needed for the client. (Correcting an earlier
  note in this cursor that claimed out/ was stale.)

### Restart-verify (this batch)

1. Barge (61da1b0): during a Lex TTS reply, speak over it. Audio stops
   immediately, not just "barge FIRED" in the log.
2. Wire (4da9157): after a worker /clear or restart, inject/supervision
   resolves the NEW session with no redirect; the worker terminal label
   shows the real project (not UNKNOWN PROJECT); the Workers panel shows
   ONE worker card (no phantom "no brainstorm" card); the worker terminal
   mirror PAINTS (not blank).
3. Typed transcript (925eecb): type to Lex (no voice). The reply RENDERS
   in the transcript with zero audio. A voice reply still renders AND is
   spoken.
4. Bell (63641c0): the notification bell shows only input-needed items
   (idle_prompt "Claude waiting on you"); no "Grooming:" rows, no "Lex
   injected raw:" rows.

Evidence is pre-wired in daemon.log; grep there first on any failure.

## Previous cursor (2026-07-18 afternoon, VOICE WORKING - PENDING SMOKE; 5 commits, daemon LIVE)

**DO NOT REWORK VOICE.** Voice capture + audible TTS + smart coalescing
are WORKING and verified live. The wave client did NOT need reverting;
the fix was surgical (one mic-feed swap + one recovery-window formula).
If voice misbehaves next session it is a TUNING/smoke item, not a
"rip it out" item. Read the commit rundown before touching anything.

Daemon HAS been restarted and is running all of this session's commits:
proven live at 17:40:58Z - an operator End-button press logged the new
SM-23 path end to end: `[lex-anchor] /end: queueing session-end
pipeline reason=dashboard-end-button` -> `[distill-pending] queued` ->
`[chunks-fallback] status='ended' flipped` -> `[chunks-fallback]
last_summary written chars=3180` -> `[distill-pending] completed
brainstorm=4bbafb48 drafts=0 summary=true`. The End-hang fix and the
guaranteed-distill-on-end both confirmed in prod. (Same trace shows the
known SM-26 open defect: `per-session distill skipped:
no_session_scoped_chunks` - summary written via fallback, content may
lag; root cause still open.)

Remaining before "done": run the smoke checklist below, then strip the
diagnostic probes. Safe to /clear.

### This session's commits (all on master, tree clean)

- `9f0d09e` fix(voice): stuck-open recovery raced redemption. THE
  capture bug. The wave client's onFrameProcessed recovery used a
  fixed 1500ms window vs the 0.4 floor; it fired at ~915ms of silence,
  before FrameProcessor redemption (1344ms) could close the utterance,
  and vad.pause() discarded the buffer (SpeechEnd never fired, se=0).
  Recovery window now max(1500, redemptionMs+1500). Also: MicVAD back
  on its own getUserMedia grant (synthetic GainNode feed retired), ORT
  wasmPaths cache-busted (?v=st1), capture/vad-err probes -> voice_health.
  **LIVE-VERIFIED 15:14:32Z `transcript received words=8`.** CLIENT,
  already deployed.
- `9a239a3` fix(lex): End button no longer hangs (SM-23). End awaited
  the full headless distill inline. All terminal ends now queue via
  new src/lex/distill-pending.ts (persisted marker, in-flight join,
  cleared on success/kept on failure); cold-start force-runs any owed
  distill for the anchor's own brainstorm, bounded 150s. DAEMON.
- `bda4ad8` feat(voice): audible TTS + smart coalescing. TTS was
  silent (engine cut moved playback to an HTMLAudioElement the
  autoplay policy rejected from a network callback -> "speaking", no
  audio). Fix: primeFromGesture() on Start-voice + retry-on-gesture in
  the queue + sink telemetry. **Audible confirmed live.** SM-25 smart
  stacking (DAEMON): top-layer turns serialize; unspoken reply
  superseded by newer utterances -> one combined re-ask; else drain
  queue as one follow-up. **Coalesce confirmed live in transcript.**
- `d79f1e9` fix(lex): honest cold-start greeting (SM-26). Preamble now
  shows distillation AGE past 6h ("20h ago ... stale, trust recent
  turns") instead of a bare dateless HH:MM that read day-old state as
  current; system prompt tells brainstorm anchors to skip the
  OTLC-Brainstorm.md check silently. DAEMON.
- `f518eb4` fix(lex): distillation guaranteed on EVERY brainstorm end
  (SM-27). ptyKill (taskkill/switch/restart/onExit-miss) ended a
  brainstorm with no distill AND defeated the onExit distiller; now
  routed through the same queue. grooming day-cap now distills before
  the ended flip. DAEMON.

### Deployed vs pending

- CLIENT (`08-dashboard/out/`, sw stamp 2026-07-18T17:04:08Z): LIVE.
  Capture fix + audible TTS are working now. Served per-request, no
  restart needed.
- DAEMON (dist built, tsc clean): SM-23/25/26/27 are in the built dist
  but the RUNNING daemon predates them. **One operator daemon restart
  (dashboard restart button) activates all four.** No auto-restart.
- Server prefs healed live: voice-preferences.json = mic_gain 1.0 /
  vad_sensitivity 0.5 / vad_redemption_ms 1400 / barge_cooldown 1500.

### Next session (more testing, per operator)

1. Restart the daemon, then smoke the daemon-side four:
   - SM-25 coalesce: talk, add a second thing before he replies -> ONE
     merged voice reply (already seen in transcript; reconfirm audible).
   - SM-23 End button: press End on a live brainstorm -> UI returns
     instantly; `[distill-pending] queued` then `completed` in
     daemon.log; spawn a new session on the same anchor -> greeting
     reflects the just-ended session, not stale state.
   - SM-27: kill a brainstorm PTY (switch-session / taskkill) -> a
     `[distill-pending]` line still fires (no silent end).
   - SM-26: fresh brainstorm greeting is grounded + honest about age,
     no "No OTLC-Brainstorm.md" noise.
2. Then delete the diagnostic probes from VoiceClient.tsx (capture
   probe `cp:`, vad-err/snk-err mirroring, sink `snk:` counters) and
   the "probe" status in voice-watchdog.ts. Self-terminating +
   harmless, but they were investigation scaffolding. Prune the
   voice_health "probe"/"cp:"/"snk:" rows.

### Open defects logged this session (not yet fixed)

1. Transcript box has NO reply channel without the voice WS: typed-only
   usage shows the question, never the answer (reply only hits the
   terminal mirror). Needs a non-voice reply path.
2. Silent-off: voice can be off/broken while the operator talks with no
   unmissable feedback; every teardown is silent. voice_health probe
   infra is the seed of the fix.
3. SM-26 deeper cause: the brainstorm-chunks fallback writes a
   fresh-stamped last_summary with RECYCLED content on
   no_session_scoped_chunks, defeating timestamp freshness verdicts.
   Needs content-aware verdicts (the age hint is a band-aid).
4. Daemon asset serving is slow under load (sw.js 6s, whisper-prewarm
   2->13s); box carries llama-server 10GB + whisper + multiple claude
   sessions. Event-loop/box-load pass owed.
5. handleUtteranceEnd's empty-micBuf + STT-error paths send client
   frames but log NOTHING server-side.
6. SM-24 open sub-item: earlier "speaking" stall (tts-start, zero PCM)
   was the autoplay bug now fixed by bda4ad8; if it recurs post-restart
   it's a genuine server synth stall - daemon logs no per-synth timing,
   add that first.

## Previous cursor (2026-07-18 overnight, voice Phase 2 + layer config - DEPLOYED)

- **HEAD:** 3b8ef37 on master, tree clean (after this docs commit). 7
  feature commits this session (see Tonight's work).
- **PROD:** daemon bounced TWICE via `POST /admin/daemon/restart`
  (endpoint arms the DevNeural-Daemon-Restart scheduled task; both
  came back clean, ~6-24s). Final pid 34592, running the freshly-built
  dist with EVERYTHING. Client `08-dashboard/out/` rebuilt (served
  per-request by @fastify/static). Fully DEPLOYED - no pending restart.
- **The "spoke to Lex / listening but nothing happened" bug is FIXED.**
  Root cause proven in the live log: the old heavy top layer returned
  `speech=null` and the turn was DROPPED (`top-layer turn speech=null
  forward=null control=none`). Phase 2 fixes it two ways: R1 haiku top
  (fast, warms in seconds not 33s) and R4 fail-safe (a null top turn
  now FORWARDS the utterance to Lex instead of dropping).
- **Layer config (live):** L1 top = haiku headless. L2 mid = opus,
  `--permission-mode bypassPermissions` (NOT plan - headless plan mode
  STALLS on the plan-approval prompt; see FUTURE-FEATURES "L2
  mechanical confirm-gate"). L3 worker = `claude --model opus
  --dangerously-skip-permissions`. LIVE opus<->fable switch, no
  rebuild: `POST /runtime-config/{mid_model,worker_model,
  mid_permission_mode} {"value":...}` - read per-spawn
  (`src/lex/layer-model.ts`, whitelisted = injection-safe). "ultracode"
  is NOT wired: not a claude flag (zero repo hits), it's a VS Code
  terminal setting the operator manages.
- **L2-confirms-before-worker:** Lex's core prompt now requires it to
  state the plan + get the operator's go-ahead before `POST
  /lex/inject-cross-session`. Prompt-enforced; mechanical gate deferred
  to FUTURE-FEATURES.
- **Operator verification:** (1) reload the PWA (SW auto-updates) for
  the client changes - three-way transcript, warming pill, /lex worker
  mirror, touch scrollbars, home Start-Claude button; (2) reopen the
  brainstorm to get the confirm-first Lex + haiku top; (3) talk - voice
  should respond. Confirm-before-dispatch + new models take effect on
  the NEXT mid/worker spawn.
- **Pre-existing reds (NOT this session):** full daemon suite = 2 fails
  = grooming-routes (FIXES.md SM-7 baseline) + one identity-file
  test-isolation flake (passes isolated). Dashboard = 2 playwright e2e
  spec files vitest can't collect (run via `npm run e2e`).

## Tonight's work (newest first)

- **Voice Phase 2 + layer config + dashboard fixes (2026-07-18, 7
  commits 4fa678d..3b8ef37, DEPLOYED via 2 daemon bounces):**
  - `926ecd1` Phase 2 "top layer always-live + fast" (VOICE-TOP-LAYER-
    SPEC.md Phase 2): TOP session now spawns `--model haiku --tools ""
    --strict-mcp-config` (was NO --model = booted account default,
    ~33s; the root cause of dropped first turns). Client stays
    "connecting" until the top brain is warm then goes live (daemon
    `voice-brain {ready}` frame, fail-open cap, no-op when disabled).
    mid-turn-no-tts hold queue retired (`_shouldDeferForwardToMidTurn
    Boundary` always false) - operator forward routes to mid LIVE (CC
    composer buffers it); the null-top-turn fail-safe (forward the
    utterance) is locked; top stays context-thin (uses pty-host.spawnLex
    directly, never the cold-start path). "askVoice queue" read as the
    operator-holding paths, NOT the single-PTY IO serialization (kept).
  - `6fe6939` Three-way transcript: the /lex transcript labels turns by
    layer - you (operator) -> lex (voice, the top hop `to Lex: ...`) ->
    lex (deep, the mid reply). daemon tags `transcript`/`assistant-text`
    with `layer` + emits a `layer-hop` frame; client renders it. Plus
    client deploy-order fail-open (new client no longer strands on
    "connecting" against an old daemon that never sends voice-brain).
  - `e1ff047` Honest status: pill says "warming" while the backend
    boots, "ready" only when ready to WORK (was "ready" the instant the
    WS bound).
  - `a86c54c` /lex worker terminal mirror (read from the tracked
    supervises binding, no anchor-logic change) + 14px touch-grabbable
    scrollbars on the terminal viewports and the page (AppShell main).
  - `4bb1608` Per-layer model + permission modes with a LIVE opus<->
    fable switch via runtime_config (`src/lex/layer-model.ts`, 10 test
    pins incl. command-injection guard). See Cursor for the config.
  - `3b8ef37` L2 confirms alignment before dispatching to the worker
    (prompt-enforced in Lex's contract).
  - `4fa678d` Restored the Start-Claude button on home ProjectsGrid
    tiles (voice-wave cc26d96 had made them read-only); wired to the
    existing startClaude path, rendering-only.

- **Voice engine replacement wave (VE-0..VE-5, 14eaded..4dfe56b, per
  VOICE-TOP-LAYER-SPEC.md):** full replacement, not patches, 100+ new
  test pins across 5 phases. Phase 0 audit findings appended to
  voice-review.md (AudioContext playback was AEC-blind = THE echo
  source; barge death = per-segment cooldown restamps x 1500ms pref;
  during-TTS window died at synth end; stop-class rode an LLM round
  trip or queued to boundary; duplicate delivery = repaste + CR storm
  + requeue; 12 bell emitters inventoried). Then the build: five pure
  engine modules (echo filter, word-gated barge, endpoint governor,
  interrupt arbiter, delivery dedupe); media-element playback queue
  (WAV segments through one HTMLAudioElement so AEC references the
  TTS, instant cancel with real played-ms, true-drain signal); daemon
  + client wired end to end (vad-onset/asr-interim/asr-final/
  playback-drained/playback-stopped frames; words interrupt, noise
  never; stop-class finals hard-interrupt mid-turn deterministically;
  echo transcripts drop loudly; context truncates to words actually
  heard; one utterance = one delivery across every re-send path;
  VoiceClient net -36 lines, cooldown gate deleted); DRIVE-QUEUE
  riders (reinforcement telemetry off the bell, idle_prompt debounced
  10min/session, cross-session injects verify delivery on both
  transports with a followup bell on stuck paste); VE-5 held-turn
  governor flush (starved mid-thought fragments ship at the 3s hard
  ceiling through the identical pipeline). Smart Turn v3 was already
  integrated + model on disk since 07-15; deck worker nesting already
  live since 4779d7b - both audit-corrected in FIXES.md, not
  re-shipped.
- **Fifth wave (SM-19..SM-22, ecc22e4):** replay-on-switch stamps
  its own delivery so ws flap can never loop the same reply (repeat
  bug the operator heard at 01:33Z; replay-once on disconnect/switch
  preserved); headless distill timeout 60s -> 180s (env
  DEVNEURAL_DISTILL_TIMEOUT_MS) after 12+ hours of every pass dying at
  the cap logged as "empty reply" - spawnHeadlessOpus now names the
  real failure (timeout / exit code + stderr tail / empty stdout);
  cold-start preload now appends the last 10 dashboard-log turns
  (brainstorm_chunks) so voice-only conversation reaches a fresh Lex
  even when distillation lags; /help rebuilt as a full help section
  (sticky topic nav, 9 topics, 4 new plain-English guides).
- **SM-18 (d238332):** ws-close is never terminal - a socket drop runs
  the distillation flush only; the brainstorm stays alive for the
  reconnect. Terminal pipeline reserved for spoken end-session, UI
  end, compaction-restart. (The old code ended live brainstorm
  4bbafb48 twice tonight; row reopened both times, last at ~01:49Z -
  it is live now.)
- **Voice fourth wave (73508bd, 65a8dc0, 7d4222a, 1cc3701 =
  SM-15/17/14/16):** delivery verifier treats the utterance
  fingerprint as THE delivery signal (no repaste/FAILED on delivered
  words; loud TRUNCATED DELIVERY line); signal-based liveness
  everywhere (jsonl growth OR pty output within 15s = alive; timeouts
  bound silence, not reply time); 15s client keepalive ping + loud
  ws-close code/reason logging; silent TTS deaths scream (no-live-sink
  guard, TTS SYNTH FAILED / TTS STREAM ERROR in daemon.log).
- **Dashboard audit wave 2026-07-16 (6ce60f2..cc26d96, GS-1..GS-12):**
  supervision default=event everywhere (migration 051 backfilled 31
  seeded-polling anchors); selector on every anchor + small-screen
  wrap; settings cards in plain English (Worker auto-clear rename,
  history headers, effective-mode line); wiki match history with
  headers/verdicts/injected previews; periodic vector flush (dirty ->
  "saving soon"); bell counts only actionable + clear-all; home tiles
  show status not controls; brief refresh regenerates + 24h self-heal;
  deck nests workers under brainstorms; curator feed clear-all +
  destination hints; terminal mirror labeled; sessions page one merged
  table; KPI artifacts/lineage wired from wiki_drafts (migration 052
  collapsed 6,972 duplicate lint findings); drafts + meetings
  empty-states explain themselves (dead /sessions/new link fixed).
- **2026-07-16 earlier voice waves (SM-1..SM-13):** see FIXES.md; verified
  live except where the checklist says otherwise.

## Known baseline noise (NOT tonight's work)

- tests/grooming-routes.test.ts: one pre-existing failure (documented
  in FIXES.md SM-7).
- tests/sessions-anchor-liveness.test.ts: environmental flake, comes
  and goes with the operator's VS Code bridge heartbeat.
- 08-dashboard: 2 Playwright e2e spec files mis-collected by vitest
  (collection error only; 233 unit tests green).
- CuratorHealthCard "canary: not wired": honest label, probe does not
  exist yet.

## Next steps

1. Operator walks RESTART-TEST-CHECKLIST items 1-26 (dashboard wave +
   voice wave) on the live daemon.
2. Any failure: evidence is pre-wired - ws closes log code/reason,
   TTS deaths log loudly, delivery truncation logs TRUNCATED DELIVERY.
   Grep daemon.log first.
3. Phase Two remains queued behind the P2-0 adversarial review of
   FUNCTIONAL-SPEC (standing project rule).
4. Meeting flow still untested end to end (checklist item 20).

## Standing rules (unchanged)

- Daemon restart is OPERATOR-ONLY unless explicitly authorized in the
  moment. Builds are fine.
- Additive-only fixes; tests green before/after; commit bodies end
  with a Rebuild: yes/no line; FIXES.md row per fix.
- Regression-guard surfaces: terminal/PTY, bridge, cross-session
  inject.
