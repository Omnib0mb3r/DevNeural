# DevNeural bug tracker

Persistent, cross-session bug log. A fresh-context agent reads the Index
first to know what is already known-broken before touching an area.

Scope note: this tracker seeds the currently OPEN / SMOKE-TESTING /
DEFERRED items. The full resolved history lives in `FIXES.md` (fix
stack, per-commit evidence), `docs/bugs/*.md` (per-bug postmortems), and
the git log. Do not transcribe resolved history here; log new bugs and
carry live status.

Statuses: `OPEN` (confirmed, not fixed) -> `SMOKE-TESTING` (fix applied,
awaiting live verify) -> `RESOLVED` (fixed and verified). `DEFERRED` =
real bug intentionally parked.

<!-- INDEX START -->
| id | status | summary |
|----|--------|---------|
| BUG-001 | SMOKE-TESTING | Stream Deck does not nest a worker under its brainstorm: tile/session slug formats differ, `===` never matches. Fix: nest by supervised worker session id. |
| BUG-002 | RESOLVED | Voice barge: a real barge is judged phantom echo and resumes over the user. RESOLVED by the LAYER-1-CONTROL baseline (`ebc3abc`): the resume mechanism is DELETED (`resumeBargedSpeech` gone, every path -> `dropBargeStash`), so a resume-over-barge cannot occur. Deployed on the 18:36 daemon. |
| BUG-003 | SMOKE-TESTING | False "voice dead" banner on long Lex replies (client watchdog time gates). Fix committed ac84b88; awaiting live verify. |
| BUG-004 | SMOKE-TESTING | False "voice error" banner on a delivered inject when deep layer is mid-turn (server delivery-verify). Fix built (VB-3); awaiting operator rebuild+live. |
| BUG-005 | RESOLVED | Deep-layer TTS truncation: mid/deep voice replies spoken only to the first sentence. Cause was the phantom-barge resume restoring only sentence 1. RESOLVED by the LAYER-1-CONTROL baseline (`ebc3abc`): resume is deleted entirely, so the deep reply plays straight through and the truncation-via-resume cannot occur. The VB-1 remainder-resume patch is now moot. |
| BUG-006 | SMOKE-TESTING | Fresh dashboard-launched worker shows unsupervised / inject auto-target 422s (VB-2). Committed d357f12; awaiting rebuild+live. |
| BUG-007 | DEFERRED | Sessions-page terminal mirror does not follow a session swap that happens WHILE the page is open (SV-4). Blank-on-open already fixed by SV-1. |
| BUG-008 | RESOLVED | L1 haiku voice-brain returned `chars=0` on every ask, breaking the smart top layer. RESOLVED: the consumer (`topLayerTurn`) is deleted, so the "never classifies / always verbatim-forwards" impact is gone. The same `askVoice` survives in `voiceLexReply` (delivery) + `voiceHeartbeat`, where a chars=0 now only triggers a graceful fallback (raw L2 body spoken directly; pulse skipped) - non-fatal. Note for any future L1 rebuild: root-cause the empty end_turn before re-wiring an L1 ask. |
| BUG-011 | SMOKE-TESTING | Stream Deck tile falsely shows "needs input" + red LED on a plain idle session. Cause: `/sessions/:id/pending-prompt` sets `pending` for ALL kinds incl. `idle_prompt` (CC "still working?" rhythm), and the tile paints any pending as `permission`. Bell already excludes idle_prompt; the tile never did. Fix: gate the permission paint on `pending.kind !== 'idle_prompt'` at both tile sites. |
| BUG-010 | SMOKE-TESTING | Mic tuner (Test mic) opens the mic then instantly tears it down; stuck on `starting…`, meter never goes live. Cause: post-await "stopped mid-init" guard reads stale React `state` closure (always looked "not starting") + `runningRef` still false, so it fires every start. Fix: cancellation token (`startTokenRef`) instead of stale state. |
| BUG-009 | SMOKE-TESTING | Bell showed telemetry despite prior fixes. Three mis-classifications: (1) "Worker stalled" emitted `signal@alert` -> rode the bell emergency lane; (2) `idle_prompt` emitted `followup` -> belled; (3) "Lex needs you" false-fired on any soft tail question. Fixed: stall -> `warn`, idle_prompt -> `signal`, attention detector requires a decision-head/yes-no ask. Awaiting operator restart + live verify. |
| BUG-012 | SMOKE-TESTING | Mic tuner + main voice both fail with `no available backend found ... RangeError: Out of memory ... previous call to 'initWasm()' failed`. Cause: MicTuner's `teardown()` calls `vad.destroy()` (kills ORT's threaded worker pool) but never `resetVadModuleCache()`, leaving the SHARED `getVadModule()` singleton flagged configured=true; the next `MicVAD.new` (tuner or main voice) lands on the dead pthread shim and cascades. VoiceClient already resets on every teardown; the tuner did not. Fix: MicTuner calls `resetVadModuleCache()` in teardown. Awaiting operator live verify. |
| BUG-013 | SMOKE-TESTING | Typed input spoken aloud (should be text-only, "brain replied"). Cause: the "still working" spoken heartbeat ran on its own `setInterval` (started by `startJsonlWatch` on the cc-pty typed path) and called `speak()` without consulting `suppressSpeakForTurn`; a long worker turn after a typed message fired a spoken pulse. Fix per operator directive 2026-07-21: the hard-coded spoken heartbeat is REMOVED entirely (wiring + `lex-voice-heartbeat.ts` + `voice-heartbeat-haiku.ts` + `voiceHeartbeat` in `voice-top-layer.ts` deleted). Any still-on-it cue returns later as a Layer 1 system-prompt behavior. Awaiting operator live verify. |
| BUG-014 | OPEN | Pre-existing test failure (not voice-related): `tests/grooming-routes.test.ts:118` expects `recentGroomingNotifications().length === 3`; fails on baseline (verified via stash) both alone and in the full suite. Discovered during the 2026-07-21 voice work; NOT caused by it. `smart-compact-injector.test.ts` also flakes on a 5s timeout in the full run but passes in isolation. |
| BUG-015 | RESOLVED | Home-page project list shows the same folder twice (observed: two "John Simms"). Identity id is hashed from the git remote when present, else the path; a folder registered before its remote existed (path id) then again after (remote id) splits into two entries. Fixed: `reconcilePathDupes` folds a path-scoped orphan into its remote twin on every `recordIdentity`, plus `reconcileAllProjects` self-heals existing dupes on daemon boot. Verified: registry 9->8, John Simms 1 row. |
| BUG-016 | RESOLVED | Registry keeps stale entries for renamed/deleted project folders (path-scoped rename = new id = orphan; old entry's root no longer exists, Start Claude would open a dead path). Fixed: `pruneMissingProjects` drops entries whose root is absent on disk, run on daemon boot after reconcile. git-remote projects self-heal instead (same remote -> same id -> root rewritten on next capture). |
<!-- INDEX END -->

<!-- DETAILS START -->

## BUG-001 — Stream Deck worker not nested under its brainstorm
- **Status:** SMOKE-TESTING
- **Found:** 2026-07-19
- **Area:** `08-dashboard/components/StreamDeck.tsx`, `07-daemon/src/lex/anchor-tiles.ts`
- **Symptom:** A worker (bridge or PTY) should render slightly nested under its supervising brainstorm tile. It does not, even though the binding is correct everywhere else (Lex tab shows the right supervised worker; the worker terminal window calls out the right worker).
- **Root cause (grounded against the live DB):** nesting at `StreamDeck.tsx:244` is `groups.find(g => g.slug === t.supervised_project_slug)` — an exact, case-sensitive string match between two DIFFERENT slug formats. Tile side `supervised_project_slug` = `project_session.project_slug` = a short name (e.g. `"DevNeural"`). Session side `group.slug` = the `~/.claude/projects/<dir>` name = the full mangled cwd (e.g. `"c--dev-Projects-DevNeural"`). They can never be `===`, so the worker drops to the orphan branch. Case is also unreliable (CC lowercases the drive letter in the dir; the VB-2 mangler `bridge-presence.ts:121` lowercases everything), so slug matching is fragile regardless. Binding is NOT the problem: `project_session.current_session_id` already resolves the exact worker session id (verified: the DevNeural anchor points at this worker's session).
- **Fix:** nest by the authoritative worker **session id** instead of the slug proxy. Tile emits `supervised_worker_session_id` (= `project_session.current_session_id`); StreamDeck nests the group containing that session id and computes orphans the same way. No change to binding.
- **Fixed:** 2026-07-19 (pending live verify on the dashboard rebuild).

## BUG-002 — Voice barge resumes over a real interruption
- **Status:** RESOLVED
- **Found:** 2026-07-19 · **Fixed:** 2026-07-20 (`ebc3abc`, deployed on the 18:36 daemon). Resume mechanism deleted, so the symptom cannot recur.
- **Area:** `07-daemon/src/voice/lex-voice-ws.ts`
- **Symptom:** talk over Lex mid-sentence; audio stops, then RESUMES the remainder ("you pause then continue"). Any non-command barge is swallowed.
- **Root cause:** the resume path put the barged speech back on every noise/echo/finish resolution. Combined with the `chars=0` L1 (BUG-008) always fail-safe-forwarding verbatim, a real barge looked like phantom echo and resumed.
- **Fix (LAYER-1-CONTROL.md baseline, 2026-07-20):** barge is now deterministic and dumb. `resumeBargedSpeech` is DELETED (every call site -> `dropBargeStash`: drop the stash, STAY stopped; the unused closure removed). The main barge forward no longer fires the deferred PTY Ctrl+C (`confirmRealBarge(false)`), so L2 finishes its reply and the full statement stays READABLE as text; only the TTS audio was cut. Emergency stop (panic -> double-ESC) is the only path that truncates L2. The `chars=0` smart L1 ask (`topLayerTurn` + `parseTopLayerReply` + `applyTopLayerControl` + the classify/rethink/finish helpers) is UNWIRED AND DELETED, not gated. `runTopLayerVoiceTurnOnce` now forwards the operator utterance straight to L2. See `docs/spec/LAYER-1-CONTROL.md`.
- **Baseline acceptance (live):** talk over Lex -> TTS stops on sound, never resumes; the full L2/L1 statement is still readable in the transcript.

## BUG-008 — L1 haiku voice-brain returns chars=0 on every ask
- **Status:** RESOLVED
- **Found:** 2026-07-20 · **Fixed:** 2026-07-20 (`ebc3abc` deleted the consumer; impact eliminated)
- **Area:** `07-daemon/src/lex/voice-brain-session.ts` (`askVoice`, log ~:863), `07-daemon/src/voice/voice-top-layer.ts` (`topLayerTurn`)
- **Symptom:** every top-layer turn logs `speech=null forward="<verbatim operator words>" control=none`; `[voice-brain] ask replied in N ms chars=0` on 48/48 conversational asks (07-20), all of 07-19. Not a timeout (`result.timedOut` false): the haiku completes its turn and emits an assistant message with ZERO text blocks ("degenerate end_turn with zero text", `voice-brain-session.ts` ~:866).
- **Impact:** the smart top layer never classifies, never speaks its own line, never emits a control or FINISH. It always fail-safe-forwards verbatim. So the rethink/finish/coalesce "L1 magic" cannot run.
- **Resolution:** the smart ask (`topLayerTurn` + its classify/rethink/finish machinery) is UNWIRED AND DELETED, so the "never classifies / always verbatim-forwards" impact is gone. The operator utterance forwards straight to L2.
- **Residual (non-fatal):** the same `askVoice` on the haiku voice-brain still runs in `voiceLexReply` (reply delivery) and `voiceHeartbeat`. A chars=0 there is handled gracefully - `voiceLexReply` returns `miss` and the caller speaks the raw L2 body directly; the heartbeat pulse is skipped. So voice works; the haiku "delivery" layer is effectively dead weight when it always empties (a future optimization, not a break).
- **If the L1 layer is ever rebuilt:** root-cause WHY the haiku emits empty end_turns (prompt shape inducing silence vs a `waitForVoiceReply` extraction bug reading the wrong block/session) BEFORE wiring any new L1 ask. Decisive test: fire one ask and dump the raw haiku jsonl for that turn.

## BUG-003 — False "voice dead" banner on long replies (client watchdog)
- **Status:** SMOKE-TESTING
- **Found:** 2026-07-19 · **Fixed:** 2026-07-19 (commit ac84b88, awaiting live verify)
- **Area:** `08-dashboard/lib/voice-watchdog.ts`, `08-dashboard/components/VoiceClient.tsx`
- **Root cause + fix:** see FIXES.md VD-1. Time gates (`frame_timeout` 30s / `buffer_stuck` 10s) flipped the dead banner on the legitimate synth gaps of a long reply. Fix: banner flips only on a real fault (`ctx_state`); time stalls heal + telemetry, never banner.

## BUG-004 — False "voice error" banner on a delivered inject (server)
- **Status:** SMOKE-TESTING
- **Area:** `07-daemon/src/voice/lex-voice-ws.ts` (`_verifyInjectDeliveryImpl`)
- **Root cause + fix:** see FIXES.md VB-3. A queued (delivered) inject was counted as silence; fix recognizes the enqueue record and returns `queued` instead of banner. Awaiting operator rebuild+live.

## BUG-005 — Deep-layer TTS truncation to first sentence
- **Status:** RESOLVED
- **Found:** earlier · **Fixed:** 2026-07-20 (`ebc3abc`, deployed on the 18:36 daemon)
- **Area:** `07-daemon/src/voice/lex-voice-ws.ts`
- **Root cause:** the phantom-barge resume restored only sentence 1 of a mid/deep reply (the VB-1 remainder-resume in fd55ef8 patched around it).
- **Resolution:** the LAYER-1-CONTROL baseline DELETED the resume mechanism entirely. The deep reply now forwards to L2 and plays straight through; a barge just stops it (no resume), so the truncation-via-resume cannot occur. The VB-1 remainder-resume patch is moot (it lived in the deleted path).

## BUG-006 — Fresh worker shows unsupervised / inject auto-target 422s
- **Status:** SMOKE-TESTING
- **Area:** `07-daemon/src/dashboard/bridge-presence.ts`, `routes.ts`
- **Root cause + fix:** see FIXES.md VB-2 (commit d357f12). `current_session_id` was null for a fresh anchor until the bridge reported a cc id; fix backfills it from the newest live jsonl for the bound cwd. Awaiting rebuild+live.

## BUG-007 — Sessions-page mirror does not follow a mid-view session swap
- **Status:** DEFERRED
- **Area:** `08-dashboard/app/sessions/detail`
- **Note:** see FIXES.md SV-4. Blank-on-open (the reported symptom) is fixed by SV-1 (anchor-resolved at connect). The remaining edge — following a swap that happens while the page is already open — needs client-side session->anchor->live polling on the Sessions detail page (mirroring the Lex page). Parked as a scoped follow-up, not added blind.

## BUG-009 — Bell still showed telemetry (worker stalled / idle / false needs-you)
- **Status:** SMOKE-TESTING
- **Found:** 2026-07-20 · **Fixed:** 2026-07-20 (awaiting operator restart + live verify)
- **Area:** `07-daemon/src/dashboard/lex-attention.ts`, `pending-prompt-notify.ts`, `routes.ts`
- **Symptom:** the bell/pill kept showing non-actionable telemetry after two prior fixes (67dc213, 63641c0). Live notifications.jsonl showed the bell-eligible set was dominated by `lex-attention/signal/alert` "Worker stalled" (14 in the last 400 rows) plus `permission/followup/warn` "Claude waiting on you (idle_prompt)", and "Lex needs you" fired when Lex was not actually asking.
- **Root cause (grounded against the live log, exhaustive emit-site sweep):** three independent mis-classifications, none caught by the earlier patches. (1) `fireForStall` emitted at `signal@alert`; the bell admits every `signal@alert` as an emergency (the "daemon down" lane), so automated supervision stalls belled. (2) The pending-prompt route tagged `idle_prompt` as `followup`, which always bells. (3) `detectAttentionInText` fired on ANY tail question <= 24 words (no decision head required), so soft/rhetorical closers ("make sense?", "sound good?") tripped "Lex needs you"; the voice path passes only text, so the heuristic decides.
- **Fix:** stall severity default `alert -> warn` (signal@warn stays on the activity rail, off the bell); `idle_prompt -> notify_class 'signal'` via `pendingPromptNotifyClass` (real permission/elicitation prompts stay `followup` and still bell); removed the catch-all tail-question rule so "Lex needs you" fires only on a yes/no marker or a decision-head question. Existing on-disk rows collapse + age off the bell via the 6h followup/signal TTL. Tests: lex-attention (25), pending-prompt-notify (8), notifications-class-filter (10) green.
- **Note:** the bell now carries only user-set reminders, "Lex needs you" (genuine asks), real permission/elicitation prompts, the cross-inject "never received an inject" followup (operator kept this one), and true `signal@alert` emergencies.

## BUG-011 — Stream Deck tile shows "needs input" on a plain idle session
- **Status:** SMOKE-TESTING
- **Found:** 2026-07-20 · **Fixed:** 2026-07-20 (awaiting daemon rebuild + restart, then live verify)
- **Area:** `07-daemon/src/lex/anchor-tiles.ts` (:108), `07-daemon/src/dashboard/sessions.ts` (:563); source of the pending: `07-daemon/src/dashboard/routes.ts` (:1391)
- **Symptom:** a brainstorm/session tile on the Stream Deck rail flips to "needs input" with a red LED after the session sits idle for a bit, even though Claude is not blocked on any question. Flips back to "thinking" the moment the user sends a prompt.
- **Root cause (grounded in code + live notifications log):** `POST /sessions/:id/pending-prompt` calls `setPending(id, message, kind)` UNCONDITIONALLY for every kind, including `idle_prompt` - Claude Code's "still working?" idle-rhythm ping. Both tile builders then do `if (pending) phase = 'permission'`, and the client renders `permission` as "needs input" + red LED. But an `idle_prompt` is NOT a user action item: the SAME route already routes it to `notify_class='signal'` (activity rail only, off the bell) per the 2026-07-20 directive, and comments at `routes.ts:1434` say so explicitly. The bell got the kind-based distinction; the tile never did. Live proof: `notifications.jsonl` shows `signal warn permission | Claude waiting on you (idle_prompt)` at 23:20 EDT, which set pending → tile went red; the next user prompt cleared pending → tile went "thinking".
- **Fix:** gate the permission paint on kind at both tile sites: `if (pending && pending.kind !== 'idle_prompt') phase = 'permission'`. A real permission/elicitation prompt still turns the tile red; an `idle_prompt` leaves the tile on its tail-derived/idle phase. Mirrors the bell's kind gating. `pending` record itself is untouched (other consumers keep it).
- **Smoke:** rebuild `07-daemon` dist + restart daemon; let a live brainstorm tile sit idle past the CC idle-prompt trigger → tile stays `idle` (not red "needs input"); fire a real numbered-choice / permission prompt → tile correctly goes red "needs input"; answer it → clears.

## BUG-010 — Mic tuner opens the mic then instantly closes it
- **Status:** SMOKE-TESTING
- **Found:** 2026-07-20 · **Fixed:** 2026-07-20 (awaiting live verify on the dashboard rebuild)
- **Area:** `08-dashboard/components/MicTuner.tsx` (`start()`)
- **Symptom:** press **Test mic**; button shows `starting…`, the mic is briefly acquired, then it tears back down. Button stays stuck on `starting…` (disabled), the live level meter never appears.
- **Root cause (grounded by reading the component):** the post-await "stopped mid-init" guard at `MicTuner.tsx:74` was `if (!runningRef.current && state !== "starting")`. `state` is a **stale closure** captured from the render that created `start()` (value `"idle"`), NOT the live `"starting"` set at the top of `start()` — so `state !== "starting"` is always `true`. `runningRef.current` is still `false` at that point (only set `true` on the next line, after the guard). Both halves true on every start, so the guard always fires: it destroys the freshly-opened vad and returns before `setState("live")`. State is left on `"starting"` and the meter never wires up.
- **Fix:** replace the stale-`state` guard with an identity cancellation token. `start()` mints `const token = {}` into `startTokenRef.current` before the awaits; after `MicVAD.new(...)` it bails only when `startTokenRef.current !== token`. `teardown()` clears `startTokenRef.current = null`, so a real Stop/unmount during init is correctly caught while a normal start proceeds to `live`.
- **Smoke:** rebuild dashboard `out/`; open voice/mic settings; press Test mic → meter goes live, level bar tracks voice, crossing the red trigger line flips TRIGGER; Stop tears down; pressing Stop mid-`starting…` does not leave the mic open.

## BUG-012 — Mic tuner poisons the shared ORT for the whole tab
- **Status:** SMOKE-TESTING
- **Found:** 2026-07-21 · **Fixed:** 2026-07-21 (pending operator live verify)
- **Area:** `08-dashboard/components/MicTuner.tsx`, `08-dashboard/lib/voice-ort-config.ts`
- **Symptom:** press the gear "Test mic" → `COULD NOT OPEN THE MIC. IS IT IN USE OR BLOCKED` (MicTuner's generic non-permission catch at `MicTuner.tsx:100`). Press main-voice Start → `mic init failed: no available backend found. ERR: [wasm] RangeError: Out of memory, [cpu] Error: previous call to 'initWasm()' failed.`
- **Root cause (grounded by reading both components):** MicTuner and VoiceClient share ONE onnxruntime-web module via the `getVadModule()` singleton (`voice-ort-config.ts:140`). `voice-ort-config.ts:165-188` documents the trap: `MicVAD.destroy()` terminates ORT's threaded-backend worker pool but leaves the singleton flagged `configured=true`; the next `MicVAD.new` lands on the dead pthread shim and cascades into exactly this error. The cure is `resetVadModuleCache()` on every destroy path. VoiceClient calls it on all three teardown/error paths (`VoiceClient.tsx:1975,3156,3276`); MicTuner (shipped 2026-07-20) never called it, so pressing the tuner's Stop poisoned ORT for the whole tab and main-voice Start then died.
- **Fix:** MicTuner imports `resetVadModuleCache` and calls it at the end of `teardown()`, right after `vad.destroy()`, mirroring VoiceClient.
- **Secondary (not fixed):** if the gear tuner and main voice both hold a live silero session at once, two InferenceSessions on the single-thread wasm heap can still OOM. Proper hardening = the tuner reuses the running VAD (or refuses to start while voice is live) instead of spinning a second ORT session. Logged as a follow-up, not done here.
- **Smoke:** rebuild dashboard `out/` (done); open gear, Test mic → meter live; Stop; then main-voice Start → connects and listens with no `initWasm` cascade. Reverse order too (voice first, then tuner).

## BUG-013 — Typed input spoken aloud via the hidden heartbeat timer
- **Status:** SMOKE-TESTING
- **Found:** 2026-07-21 · **Fixed:** 2026-07-21 (pending operator live verify)
- **Area:** `07-daemon/src/voice/lex-voice-ws.ts` (+ deleted `lex-voice-heartbeat.ts`, `voice-heartbeat-haiku.ts`, `voiceHeartbeat` in `voice-top-layer.ts`)
- **Symptom:** type a message in the main voice box and Lex talks back aloud; a typed turn should render text-only in the transcript ("brain replied" / `lex (brain):`) and never synthesize audio.
- **Root cause (grounded by reading the daemon):** the two reply-speak sites DO honor `suppressSpeakForTurn` (typed → `tts-skipped`, `lex-voice-ws.ts:2689` legacy + `:3362` direct-llm), and the flag is set true on the typed path (`:5114`). But the "still working" heartbeat ran on its OWN `setInterval`, started by `startJsonlWatch()` on the cc-pty typed path (which also stamps `awaitingResponseSince`), and called `speak(line)` WITHOUT checking `suppressSpeakForTurn`. The flag's own comment even said it was "read at the two speak() sites only" — the heartbeat was a forgotten third speak site. So a typed message whose worker turn ran longer than the heartbeat interval got a spoken pulse.
- **Fix (operator directive 2026-07-21: no hard-coded spoken heartbeats, ever):** the spoken heartbeat is REMOVED entirely, not just gated. Deleted the `startHeartbeat`/`stopHeartbeat` timer + its state and call sites in `lex-voice-ws.ts`, the `voiceHeartbeat` brain-ask in `voice-top-layer.ts`, and the pure helper modules `lex-voice-heartbeat.ts` + `voice-heartbeat-haiku.ts` (and their tests). Any still-on-it cue will be reborn later as a Layer 1 system-prompt behavior, not a daemon `setInterval`.
- **Verify:** `tsc` clean; full daemon suite 2027 pass (2 unrelated failures, see BUG-014). Live: type into the voice box during a long worker turn → transcript shows the reply under `lex (brain):` with NO audio and a `tts-skipped` frame; a subsequent VOICE turn still speaks.

## BUG-014 — Pre-existing grooming-routes test failure (not voice)
- **Status:** OPEN
- **Found:** 2026-07-21 (discovered during voice work; not caused by it)
- **Area:** `07-daemon/tests/grooming-routes.test.ts`, `07-daemon/src/dashboard/routes.ts` (`recentGroomingNotifications`)
- **Symptom:** `tests/grooming-routes.test.ts:118` `expect(recent.length).toBe(3)` fails. Confirmed pre-existing: with the 2026-07-21 voice changes stashed, the test still fails on baseline (BASE_EXIT=1), alone and in the full run.
- **Note:** `tests/smart-compact-injector.test.ts` ("defers summary inject until awaitSessionReady resolves ready=true") also fails in the full suite on a 5s timeout but PASSES in isolation → a flake/ordering issue, distinct from this real failure.
- **Root cause:** not investigated (out of scope for the voice work). Left OPEN.

## BUG-015 — Home-page project list shows the same folder twice
- **Status:** RESOLVED
- **Found:** 2026-07-23 · **Fixed:** 2026-07-23 (reconcile-on-record + boot self-heal; live-verified)
- **Area:** `07-daemon/src/identity/registry.ts`, `07-daemon/src/identity/project-id.ts`, `07-daemon/src/daemon.ts`
- **Symptom:** two "John Simms" tiles in the "Start Claude" list, both pointing at `C:/dev/Projects/John Simms`, registered ~49s apart: `c7d8557a05fd` (remote null) and `54c750174212` (remote `github.com/omnib0mb3r/john-simms-micro-resort`).
- **Root cause:** `resolveProjectIdentity` hashes the id from the git remote URL when one exists, else from the lowercased path. A project created folder-first (the operator's brainstorm-makes-the-folder workflow) registers path-scoped BEFORE the git remote is added, then remote-scoped AFTER. Two ids, same folder. Nothing reconciled the split.
- **Fix:** `reconcilePathDupes(identity, reg)` runs inside `recordIdentity`: when a remote identity is recorded, any path-scoped entry with the same normalized root is folded into it (earliest `first_seen` preserved, orphan deleted). `reconcileAllProjects()` applies the same sweep across the whole registry once on daemon boot (`daemon.ts`, after migrations) so pre-existing dupes heal without waiting for a fresh session.
- **Verified:** registry 9->8 entries; John Simms collapsed to the single remote-scoped `54c750174212`; `register-path` on the same folder returns `already_registered=true` and creates no new row.
- **Residual:** the orphan's data dir `C:/dev/data/skill-connections/projects/c7d8557a05fd/` remains on disk (observation history). Harmless, unlisted. Purge manually if desired.

## BUG-016 — Registry keeps stale entries for renamed/deleted folders
- **Status:** RESOLVED
- **Found:** 2026-07-23 · **Fixed:** 2026-07-23 (boot prune)
- **Area:** `07-daemon/src/identity/registry.ts` (`pruneMissingProjects`), `07-daemon/src/daemon.ts`
- **Symptom:** rename or delete a project folder on disk and its old registry entry lingers with a now-dead `root`; Start Claude on it would open a path that no longer exists, and a path-scoped rename also spawns a second entry under the new path.
- **Root cause:** the registry is append/upsert only and never reconciles against the filesystem. A path-scoped rename produces a new id (the path changed) and orphans the old one; a delete leaves the entry entirely.
- **Fix:** `pruneMissingProjects()` drops any entry whose `root` is absent (`!fs.existsSync`), run on daemon boot right after `reconcileAllProjects`. git-remote-scoped renames self-heal separately: same remote -> same id -> `recordIdentity` rewrites `root` to the new toplevel on the next capture, so prune only ever removes genuinely dead folders.
- **Verified:** boot ran clean (registry count held at 8, nothing valid removed); logic only deletes entries with a missing on-disk root.

<!-- DETAILS END -->
