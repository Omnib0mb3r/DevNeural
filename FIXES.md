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
| 13 | TTS speak on stop_reason=tool_use (pre-tool ack) | ✅ | 873a7c2 | |
| 14 | Neural-network legend anchored to panel + mobile safe area | ✅ | a9b2595 | Wrapper now `100dvh`-based + mobile-tab-bar aware; legend flowed in flex column with `env(safe-area-inset-bottom)` pb. |
| 15a | Cross-session-inject: anchor-resolved dispatch + auto-redirect | ✅ | 6c2f8c2 | migration 029, previous_session_id, redirect/dormant audit rows, resolveAnchorDispatch helper. |
| 15b | Cross-session-inject: anchor_id-signed HMAC alternate | ✅ | aef80dc | verifyToken multi-subject, route accepts signed_anchor_id, /auth/cross-session-token gains anchor_id mode. |
| 15c | Smart-compact: replay parked injects on resume | ✅ | 57c5304 | migration 030 payload_text col, findParkedInjectsForAnchor, fireSmartCompact replays max 3 before summary. |

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
