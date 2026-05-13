# DevNeural TODO

Captured 2026-05-04. Living list. Tick when shipped.

## Polish (from agent E handover read)

- [-] Android push notification end-to-end test. Dropped per user.
- [x] PWA install prompt UX. Scaffold already implemented; only token mismatch fixed.
- [x] System panel sparklines. Already shipped (SparkAreaChart, 60-sample buffer, both metrics).
- [x] Axe a11y sweep across home, sessions, wiki, projects, system, reminders, orb. Zero violations after adding sr-only h1 to /orb.
- [x] `prefers-reduced-motion` audit. Existing global rule in `globals.css:253-255` already pins durations to 0ms. Orb particle pause via `cooldownTicks` finite when `prefers-reduced-motion: reduce` is a future-pass enhancement.
- [-] Tailwind arbitrary class cleanup (`text-[11px]` -> `text-nano`). Skipped: `text-nano` utility forces uppercase/tracked-out display, would change visual semantics for user-readable labels.
- [x] Scanned PDF OCR fallback. `pdf.ts` now rasterizes + OCRs via pdf-to-png-converter + tesseract.js when text density looks scanned. Bounded by page count + time.
- [x] Off-site git remote for wiki repo. `Omnib0mb3r/devneural-wiki` (private) created and pushed. Daemon-side scheduled push every 5 min via `wiki/push.ts`.

## Validation

- [ ] Trigger a real reinforcement event in conversation. Send Claude a prompt where the wiki should match, watch dashboard ReinforcementPanel for an `injected` row, then watch for `hit` / `raw-hit` after the reply lands. Confirms curator + reinforcement + panel chain end-to-end.
- [ ] Live verify Lex session rewrite (commit `5af07d0`). Open past anchor on /lex, confirm spawn-or-bind works, check Brainstorms group renders in Stream Deck, hit end on a session.

## Deferred Wave 2 Day 5 (Lex personality track)

- [ ] Step 20 (LX-1) prompt versioning archive. Daemon writes `07-daemon/data/lex-prompts/<version>.md` on every prompt change. Version = monotonic ISO timestamp + short hash. Backfill existing prompts on first run. Foundation for step 21 A/B replay harness.

## Next after project-anchors spec

- [ ] Global panic button on the main dashboard, next to mute/stop. Single click sends double-ESC (`\x1b\x1b`) to the currently active session via the existing PTY inject path. New endpoint variant (or flag on inject) for raw key bytes, `commit=false`. Defer per-tile mini panic until usage shows it's needed. Reason: emergency stop for a runaway session, muscle memory next to existing stop.
- [ ] Smart compact (queued after panic button). Spec at `docs/spec/SMART-COMPACT.md`. Default threshold 60% +/- 5, two-condition trigger (window + stop point), forced wrap-and-commit fallback, hard ceiling 90%, shadow mode first per anchor.
- [ ] Lex dashboard controls (queued after smart compact). Add endpoints like `POST /voice/mute`, `POST /voice/unmute`, `POST /voice/stop` that push state changes over the existing voice WS to the dashboard client. Expose as Lex tools so Lex can mute/unmute itself or stop the voice session on voice command. Reason: hands-busy control without touching the UI.

## Stream deck (virtual deck in dashboard)

- [x] Arrow tile foreground color: was greyed-out slate, now pure white for visibility.
- [x] Tile-tap focus and Nav-mode key inject. Routed through StreamDeck.App tray (commit `3147c41` in stream-deck repo, `59cfd2e` in DevNeural). Tray app holds the OS focus rights the bridge could not. Daemon writes to `%LOCALAPPDATA%\stream-deck\virtual-input\<sessionId>.in`, app's VirtualInputWatcher dispatches through the same WindowManager.FocusWindow + NavKeymap.InjectFor paths the physical deck uses.
- [x] Workspace resolution: ResolveVSCodeWindowSmart walks cwd segments deepest-to-shallowest so a session launched in a subdir (e.g. `07-daemon`) still resolves the workspace-root VS Code window (`DevNeural`).

## Deferred / future

- Phase 4 Orb data rebind. Force-directed UI shipped; pages-as-nodes data layer awaiting more accumulated wiki content.
- Phase 5 settings audit + personalized recovery docs. Mostly documentation.
- Audio/video binary smoke test post whisper.cpp + ffmpeg install.
- **Phase 7 voice identity bundle** (planned 2026-05-10): pyannote-based speaker diarization so Lex distinguishes primary user voice from third-party / background speech and routes ambient utterances out of the reply path. Same enrolled voice profile doubles as a voice-unlock biometric (with liveness check) for dashboard / Lex auth, augmenting PIN. Bundled with Phase 7 Lex personality fine-tune.

## Phase Two queue (2026-05-09; superseded 2026-05-10)

**Authoritative plan now lives in `docs/spec/PHASE-TWO-IMPLEMENTATION.md` (3 waves over ~3 weeks, post-CODEX-REVIEW-001 + 002 adoption). Day-1 verifications in `docs/spec/PHASE-TWO-DAY-1-VERIFICATIONS.md`. Active branch: `phase-two`. Resume guidance in `docs/HANDOVER-2026-05-10-phase-two-wave-1-day-1.md` (covers Wave 1 days 1-3 + Wave 2 entry).** P2-0 through P2-5 below are superseded; the same goals are tracked under spec section 11 wave structure with concrete file paths and step ordering. P2-0 (adversarial review of FUNCTIONAL-SPEC.md) is scheduled for Wave 3 day 5 per spec section 12 step 14.

- [x] **P2-0** Superseded: scheduled for Wave 3 day 5 against `docs/spec/FUNCTIONAL-SPEC.md`. Implementation-plan reviews already completed (CODEX-REVIEW-001 + 002, both adopted).
- [x] **P2-1** Tracked as Wave 2 day 5 steps 20-23 in `PHASE-TWO-IMPLEMENTATION.md`.
- [x] **P2-2** Tracked as Wave 3 day 3 + Appendix R (gated on Curator Health green for 7 days).
- [x] **P2-3** Tracked as Wave 1 step 22 (in-flight on phase-two branch) + Wave 2 day 5 step 24.
- [x] **P2-4** Tracked as Wave 2 day 2 (`/brainstorms` route) + Wave 3 day 2 (unified orb).
- [x] **P2-5** Tracked as Wave 3 day 4 (docs + restore drill + cold-start test).

## Bugs / friction (captured 2026-05-13 brainstorm)

- [ ] **Dashboard rebuild after panel commits is manual + invisible.** Operator hits /system after a commit and sees stale UI; no signal that `.next` is older than the latest source. Solution (preferred): daemon spawns and supervises `next dev -p 3000` as a managed child process at startup, restarts on crash, kills on stop. Runtime_config toggle `dashboard_supervisor_enabled` (default on, off for CI). Mirrors existing capture/ingest worker supervision. Removes the human rebuild step entirely; hot-reload covers all future code changes. Fallback option: "Rebuild dashboard" button on /system panel that shells `npm run build` + bounces `npm start`.
- [ ] **Bridge cc_session_ids goes empty when worker idle >30s. Fix: make cc_session_id sticky, gated on bridge presence freshness not jsonl mtime.** Current `CC_JSONL_FRESH_MS = 30_000` re-derives the UUID every tick by scanning for jsonls modified in the last 30 seconds. A live worker terminal that hasn't written a turn in 30+ seconds disappears from `/sessions`, anchor flips `current_session_id=null`, cross-session inject fails with `target_session required`. Correct design: presence-file heartbeat is the persistence signal. Bridge latches the latest jsonl UUID once and keeps reporting it in cc_session_ids until the terminal actually closes (deactivate event, or new session UUID supersedes). Daemon side trusts the sticky value as long as the presence file keeps heartbeating. Operator can then distinguish "worker died" (presence stale or gone) from "worker idle" (presence fresh, session intact).
- [ ] **Dashboard lock state has no visible indicator. Operator can't tell when /unlock is required.** Currently the unlock screen appears unprompted on a navigation, but there's no persistent lock/unlock pip in the chrome (TopBar, status corner, etc) telling the operator the session is locked or about to expire. Result: guessing whether to re-auth, surprise redirects, lost flow state. Fix: surface a small lock indicator (icon + tooltip showing remaining session time) in TopBar; add explicit "Lock now" affordance so the operator can re-test the gate intentionally; consider extending session TTL or sliding-window refresh so casual idle doesn't bounce to /unlock mid-workflow.
- [ ] **Cold-start preload SessionStart hook may not be firing on Lex sessions.** With `mode=live` set on `/lex/cold-start-preload/toggle`, `injection-log?caller_label=cold-start-preload` returns zero rows. This Lex session (`03525f9f`) bound its anchor via `[lex-anchor] reopen` but the new preload audit/inject path never ran. Verify: which hook event the route is wired to, whether Lex sessions pass the brainstorm-resolve gate, whether errors are being swallowed pre-audit.

## Pre-publish (before GitHub release)

- [ ] Comprehensive docs rewrite. Audit + rewrite every README, in-tree note, and how-to so an outside reader can understand: what each subsystem does (daemon, bridge, dashboard, lex, hooks, curator, wiki, orb, stream-deck), how they connect (data flow, IPC, presence files, HMAC tokens, runtime_config), and how to operate them (install, run, troubleshoot, observability). One canonical top-level README pointing into per-subdir READMEs. Captured 2026-05-13 during brainstorm.

## Operational

- [x] Audit and prune `~/.claude/settings.json.*.bak.*` backup files. Six stale backups deleted; `settings.json.bak` kept as canonical recovery point.
- [x] `silence-all-hooks.ps1` redesigned around a native silent-shim.exe. Stdin pipes through, child runs hidden, hook stdout reaches Claude. Build with `dotnet publish` in `07-daemon/scripts/silent-shim`, then `npm run silence-hooks`.
- [x] Bridge `focusWindow` + `injectKey` + nav PS helpers removed (commit `aee3053`). Bridge is now text-only.
- [x] deck-hook.sh double-escape bug fixed at source (stream-deck commit `605688b`). Segment-walk in C# is still useful as a fallback when Claude is launched from a workspace subdirectory.
