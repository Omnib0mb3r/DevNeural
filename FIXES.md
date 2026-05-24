# Fix stack tracker

Ephemeral coordination doc between Lex and the operator for the
current Fix 1-13+ work cycle. Purged once the whole stack ships and
the smoke test passes. The git history is the durable record; this
file is for live status only.

Status legend: ⏳ queued, 🔄 in progress, ✅ shipped, ❌ blocked.

| # | Title | Status | Commits | Notes |
|---|-------|--------|---------|-------|
| 1 | Voice settings auto-resync on daemon ws reconnect | ✅ | d31bfd2 | |
| 2 | /health audio block + ok=false on orphaned session | ✅ | ca05284 | |
| 3 | smart-compact wait for new session SessionStart | ✅ | 2a9fda9 | |
| 4 | Dashboard copy rewrite (7 pages + Mac glyph sweep) | ✅ | 289940e, 462aa95, 9e0ccc2, 44406e1, 839d17c, 34fa555, b55c048 | |
| 5 | Docs cleanup (7 items) | ✅ | 3002983, 1c597d7, 0f9aa8e, dcceed3, 52480a3, e8287c6, dbd8cfb | |
| 6 | Responsive top-bar + supervision chips segmented | ✅ | 888ca50, 525e707, 80589cb | Voice-pill icon-only restructure at <480px still needs in-browser sweep. |
| 7 | Six-section resume builder | ✅ | 8d34148 | |
| 9 | Notifications classifier + bell filter | ✅ | 4a0c7c4 | |
| 10 | Wake-word audit + standby/listen + voice-commands.md | ✅ | ec614a6, a06c838 | |
| 11 | Dashboard Help page scaffold + content | ✅ | 927b88b, bfa0d1b, 488e5f6 | |
| 12 | Feedback memories baked into Lex system prompt | ✅ | 2eb63b7 | |
| 13 | TTS speak on stop_reason=tool_use (pre-tool ack) | ✅ | 873a7c2 | Smoke verified live 2026-05-17 ~10:07 EDT (iPad client). |
| 14 | Neural-network legend anchored to panel + mobile safe area | ✅ | a9b2595 | Wrapper now `100dvh`-based + mobile-tab-bar aware; legend flowed in flex column with `env(safe-area-inset-bottom)` pb. |
| 15a | Cross-session-inject: anchor-resolved dispatch + auto-redirect | ✅ | 6c2f8c2 | migration 029, previous_session_id, redirect/dormant audit rows, resolveAnchorDispatch helper. |
| 15b | Cross-session-inject: anchor_id-signed HMAC alternate | ✅ | aef80dc | verifyToken multi-subject, route accepts signed_anchor_id, /auth/cross-session-token gains anchor_id mode. |
| 15c | Smart-compact: replay parked injects on resume | ✅ | 57c5304 | migration 030 payload_text col, findParkedInjectsForAnchor, fireSmartCompact replays max 3 before summary. |
| 16a | deck-hook tolerate missing tmp file (defense) | ✅ | stream-deck 83f46c7 | `[ -f "$TMP" ]` guard stops the `mv: cannot stat` flood on the CC UI immediately. |
| 16b | GET /projects/anchors/by-session/:uuid (DevNeural side) | ✅ | dc8f41a | additive endpoint for external state-keying consumers (deck-hook, future supervisors). |
| 16c | deck-hook anchor-keyed state + race-safety | ✅ | stream-deck 77db4c2 | bounded retry on daemon lookup, pid+nanos TMP suffix for concurrent hooks, AnchorId/RecordedSessionId in payload. |
| 16d | one-shot migration of legacy uuid-keyed state files | ✅ | stream-deck 505c43d | mtime>60s guard for Race 3, marker file gate at `.migrated-fix16`, content-idempotent. |
| 16e | virtual deck source change | ⏭ skipped | — | Per amendment 2 conditional: virtual deck reads `/sessions` endpoint, not state files; layout change is transparent. No commit needed. |
| 17 | TTS barge-in regression (watchdog desync) | ✅ | d6f094a | resetTtsPlayback now clears ttsActiveRef and stamps lastBufferProgressTsMsRef so the c2335c5 watchdog stops misreading post-barge-in as buffer_stuck. Dashboard React, no rebuild needed. |
| 18 | Cross-session-inject deliverability gate | ✅ | f9ce914 | Presence payload gains has_terminal_for_uuid; filename gains __<bridge-id> so multi-window same-cwd does not clobber. Bridge halts offset on [skip]. Daemon resolveDeliverableBridgeForSession returns deliverable / legacy-grace / no_terminal / not_claimed. crossSessionInject short-circuits with decision='no_deliverable_bridge' when no bridge has a terminal. Migration 032 widens decision CHECK. Absorbs cold-start-blind bug. Rebuild + restart required for daemon + bridge VSIX. |
| 19 | Voice-mode inject missing CR (regression) | ✅ | 6195466 | ptyInject (pty-host.ts:754) now writes body+\r atomically in one pty.write call when commit=true, replacing the prior 80ms setTimeout that raced ahead of the bracketed-paste close terminator. A second bare \r nudge fires ~1s later per the durable user rule (belt-and-suspenders, idempotent). buildPtyInjectPayload extracted as a pure helper; tests/pty-inject-payload.test.ts pins the contract. Voice WS dispatch picks up the fix transparently (state.bindKey targets the daemon-owned Lex PTY; bridge fallback was already wired in Fix 18 for the cross-session-inject hop). Rebuild: yes (07-daemon dist regen). |
| 20 | Voice barge cancels Lex mid-turn (critical) | ✅ | a00cea6 | killActiveTts step 3 (PTY Ctrl+C) now lives inside the same `if (ctx)` block as steps 1+2, so the abort only fires when TTS was actually playing. New state.pendingUserUtterances queue captures mid-turn-no-tts utterances; handleUtteranceEnd pushes them and returns `{t:'queued-mid-turn'}`. handleJsonlLine calls flushPendingUtterances() the instant Lex's end_turn lands (awaitingResponseSince clears on a non-pre-tool-ack record), shipping the deferred follow-ons as one combined `[voice-context: queued-mid-turn-utterances (N)]` inject. Preserved unchanged: TTS-cancel + partialChain (interrupted-replies pipeline), voice-command precedence, AEC-residual gate, direct-llm runtime mode. Rebuild: yes (07-daemon dist regen). |
| 21 | Push respects notify_class taxonomy (Fix 9 follow-up) | ✅ | _pending commit_ | push.ts maybePushNotification gate matrix updated to honor Fix 9 notify_class. New policy: conversation -> skip (matches bell filter), report -> send (end-of-session / handover), followup -> send (action-required), signal + severity=info -> skip, signal + severity>=warn -> send. Legacy rows without notify_class default to conversation (safer, matches bell filter default). mode=force preserves the conversation skip so class beats mode. End-of-session emit added to runSessionEndPipeline wrapper with notify_class='report' + source='session-end' so the bell + phone push surface the wrap on every primary-runner path (voice "end session", PTY exit, idle-watcher day-cap, admin redistill). Rebuild: yes (07-daemon dist regen). |

> **Note: no Fix 8.** The slot was skipped intentionally between
> Fix 7 and Fix 9; the original Fix 8 placeholder did not earn its
> number and was never specced. The numbering gap is preserved on
> purpose so the per-fix commit subjects stay traceable.

## Smoke test (pending)

Single restart + verification sweep deferred per the original
process directive. To run once the stack lands:

1. `cd 07-daemon && npm run build` — daemon dist regen.
2. `cd 08-dashboard && npm run build` — dashboard static export regen.
3. Restart the daemon (admin route or task scheduler).
4. Verify Fix 1: open `/lex`, restart daemon, watch ws reconnect
   trigger Settings reset toast.
5. Verify Fix 2: `curl /health` during the daemon-down window
   returns `ok=false` with `audio.session_bound=true` and
   `audio.worker_alive=false`; flips back to `ok=true` after
   workers respawn.
6. Verify Fix 3: `POST /lex/smart-compact/fire` against a
   bridge-bound worker submits the resume summary across the 7s
   new-session init gap with no manual rescue CR.

## Cleanup

Delete this file once the smoke test passes.
