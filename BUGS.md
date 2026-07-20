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
| BUG-002 | SMOKE-TESTING | Voice barge: a real barge is judged phantom echo and resumes over the user. Fixed by the LAYER-1-CONTROL baseline tear-out: barge never resumes (all `resumeBargedSpeech` hot-path calls -> `dropBargeStash`), and no Ctrl+C truncation so the L2 statement stays readable as text. Awaiting operator restart + live verify. |
| BUG-003 | SMOKE-TESTING | False "voice dead" banner on long Lex replies (client watchdog time gates). Fix committed ac84b88; awaiting live verify. |
| BUG-004 | SMOKE-TESTING | False "voice error" banner on a delivered inject when deep layer is mid-turn (server delivery-verify). Fix built (VB-3); awaiting operator rebuild+live. |
| BUG-005 | SMOKE-TESTING | Deep-layer TTS truncation: mid/deep voice replies spoken only to the first sentence (VB-1). Committed fd55ef8; awaiting rebuild+live. |
| BUG-006 | SMOKE-TESTING | Fresh dashboard-launched worker shows unsupervised / inject auto-target 422s (VB-2). Committed d357f12; awaiting rebuild+live. |
| BUG-007 | DEFERRED | Sessions-page terminal mirror does not follow a session swap that happens WHILE the page is open (SV-4). Blank-on-open already fixed by SV-1. |
| BUG-008 | DEFERRED | L1 haiku voice-brain returns `chars=0` (empty end_turn) on EVERY conversational ask, so the smart top layer never classifies/speaks and always fail-safe-forwards verbatim. Bypassed at baseline (`DEVNEURAL_L1_SMART` off, ask torn out of the live path). Must be root-caused before the L1 smart rebuild. |
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
- **Status:** SMOKE-TESTING
- **Found:** 2026-07-19 · **Fixed:** 2026-07-20 (awaiting operator restart + live verify)
- **Area:** `07-daemon/src/voice/lex-voice-ws.ts`
- **Symptom:** talk over Lex mid-sentence; audio stops, then RESUMES the remainder ("you pause then continue"). Any non-command barge is swallowed.
- **Root cause:** the resume path put the barged speech back on every noise/echo/finish resolution. Combined with the `chars=0` L1 (BUG-008) always fail-safe-forwarding verbatim, a real barge looked like phantom echo and resumed.
- **Fix (LAYER-1-CONTROL.md baseline, 2026-07-20):** barge is now deterministic and dumb. `resumeBargedSpeech` is DELETED (every call site -> `dropBargeStash`: drop the stash, STAY stopped; the unused closure removed). The main barge forward no longer fires the deferred PTY Ctrl+C (`confirmRealBarge(false)`), so L2 finishes its reply and the full statement stays READABLE as text; only the TTS audio was cut. Emergency stop (panic -> double-ESC) is the only path that truncates L2. The `chars=0` smart L1 ask (`topLayerTurn` + `parseTopLayerReply` + `applyTopLayerControl` + the classify/rethink/finish helpers) is UNWIRED AND DELETED, not gated. `runTopLayerVoiceTurnOnce` now forwards the operator utterance straight to L2. See `docs/spec/LAYER-1-CONTROL.md`.
- **Baseline acceptance (live):** talk over Lex -> TTS stops on sound, never resumes; the full L2/L1 statement is still readable in the transcript.

## BUG-008 — L1 haiku voice-brain returns chars=0 on every ask
- **Status:** DEFERRED (bypassed at baseline)
- **Found:** 2026-07-20
- **Area:** `07-daemon/src/lex/voice-brain-session.ts` (`askVoice`, log ~:863), `07-daemon/src/voice/voice-top-layer.ts` (`topLayerTurn`)
- **Symptom:** every top-layer turn logs `speech=null forward="<verbatim operator words>" control=none`; `[voice-brain] ask replied in N ms chars=0` on 48/48 conversational asks (07-20), all of 07-19. Not a timeout (`result.timedOut` false): the haiku completes its turn and emits an assistant message with ZERO text blocks ("degenerate end_turn with zero text", `voice-brain-session.ts` ~:866).
- **Impact:** the smart top layer never classifies, never speaks its own line, never emits a control or FINISH. It always fail-safe-forwards verbatim. So the rethink/finish/coalesce "L1 magic" cannot run.
- **Baseline handling:** the smart ask (`topLayerTurn` and its classify/rethink/finish machinery) is UNWIRED AND DELETED so the operator utterance forwards straight to L2 with no empty ask, no 4-13s latency, no `chars=0`. Behaviour equals the prior effective behaviour minus the wasted round trip.
- **Still to do (if/when the L1 layer is rebuilt):** the L1 magic is rebuilt from scratch on top of the baseline (LAYER-1-CONTROL.md). Before wiring any new L1 ask, root-cause WHY the haiku emitted empty end_turns (prompt shape inducing silence vs a reply-extraction bug in `waitForVoiceReply` reading the wrong block/session). Decisive test: fire one ask and dump the raw haiku jsonl for that turn.

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
- **Status:** SMOKE-TESTING
- **Area:** `07-daemon/src/voice/lex-voice-ws.ts`
- **Root cause + fix:** see FIXES.md VB-1 (commit fd55ef8). Phantom-barge resume restored only sentence 1; fix re-speaks the un-played remainder of the whole body. Awaiting rebuild+live.

## BUG-006 — Fresh worker shows unsupervised / inject auto-target 422s
- **Status:** SMOKE-TESTING
- **Area:** `07-daemon/src/dashboard/bridge-presence.ts`, `routes.ts`
- **Root cause + fix:** see FIXES.md VB-2 (commit d357f12). `current_session_id` was null for a fresh anchor until the bridge reported a cc id; fix backfills it from the newest live jsonl for the bound cwd. Awaiting rebuild+live.

## BUG-007 — Sessions-page mirror does not follow a mid-view session swap
- **Status:** DEFERRED
- **Area:** `08-dashboard/app/sessions/detail`
- **Note:** see FIXES.md SV-4. Blank-on-open (the reported symptom) is fixed by SV-1 (anchor-resolved at connect). The remaining edge — following a swap that happens while the page is already open — needs client-side session->anchor->live polling on the Sessions detail page (mirroring the Lex page). Parked as a scoped follow-up, not added blind.

<!-- DETAILS END -->
