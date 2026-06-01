# DevNeural TODO

Captured 2026-05-04. Living list. Tick when shipped.

**For current cycle state + recommended next move, read
`docs/HANDOVER.md` first.** This file is the durable backlog; the
handover doc is the live cursor.

Last refreshed: 2026-06-01 after Fix 52 through Fix 60 cycle. All
items called out as "outstanding" during that cycle are now `[x]`.
What remains is hardware-gated smoke (see `docs/SMOKE-TEST.md`),
pre-publish prep (docs rewrite + dead-code sweep), Tier 5
investigations awaiting ship (Fix 24/25/26 + voice PTY paste-no-
commit), and longer-horizon spec work (Phase 7 / Phase 8).

## Gotchas worth knowing (read before debugging restart issues)

- **Three independent build steps, none chain.** `07-daemon`, `08-dashboard`, `09-bridge` each need their own `npm run build` after source edits. Restart-daemon alone covers only daemon dist. See [HOW-TO-dev-vs-prod-dashboard](docs/HOW-TO-dev-vs-prod-dashboard.md).
- **Port 3000 vs 3747.** 3000 = next-dev (hot-reload). 3747 = prod static (frozen until `08-dashboard npm run build`). Daemon restart updates neither dashboard on its own.
- **Daemon restart is operator-only** unless the operator has
  explicitly authorized it in the active conversation.
- **No em dashes anywhere.** Period. Output, code comments, test
  fixtures, docs, commit messages.
- **Two-commit pattern.** Investigation doc first, ship second. Per-
  bug doc status flipped to CLOSED + SHA + FIXES pointer in the
  same cycle as the ship.

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

- [ ] **Smoke 5.x live capture of vad-error ring buffer (Fix f237673).** Code path verified at `08-dashboard/components/VoiceClient.tsx:2483` + `:2588` (logVoice call wired inside mic-init catch). Live ring-buffer capture deferred from 2026-05-25 smoke because trigger requires desktop with controllable mic; user was on phone. When next OOM occurs naturally OR on a desktop session, deny/kill mic mid-stream, then open Voice diagnostics panel WITHOUT Settings reset and verify a `vad-error` row in the voice pipeline log with the OOM message.
- [ ] Trigger a real reinforcement event in conversation. Send Claude a prompt where the wiki should match, watch dashboard ReinforcementPanel for an `injected` row, then watch for `hit` / `raw-hit` after the reply lands. Confirms curator + reinforcement + panel chain end-to-end.
- [ ] Live verify Lex session rewrite (commit `5af07d0`). Open past anchor on /lex, confirm spawn-or-bind works, check Brainstorms group renders in Stream Deck, hit end on a session.

## TTS sanitizer

- [x] Daemon-side `sanitizeForTts(text)` shipped 2026-06-01 (Fix 59). New module `07-daemon/src/voice/tts-sanitize.ts` strips Windows + POSIX paths to basenames, URLs to host only, UUIDs + long hex digests to "opaque id", angle-bracket markup, and collapses whitespace. Wired into `piper.ts` `synthesize()` so every TTS string passes through before reaching piper stdin. 14 test pins cover the rule matrix + idempotency.

## Deferred Wave 2 Day 5 (Lex personality track)

- [x] Step 20 (LX-1) prompt versioning archive. Already shipped per `prompt-archive.ts` + live archive directory at `C:/dev/data/skill-connections/lex-prompts/` (timestamped files visible). System-prompt assembly calls `archivePromptVersion` from `buildLexSystemPromptVersioned`. Foundation for step 21 A/B replay harness in place.

## Next after Stage 0-2 smoke (LEX-AUTONOMY-PAYLOAD-SPEC)

- [x] **Voice "lex end session" = End button parity (Fix 30).** Shipped 2026-05-31. `lex-voice-ws.ts:end_session` now follows `fireSessionEndPipeline('voice-command')` with `ptyKill(row.current_pty_id)` + `setLexSessionStatus(anchorId, {status:'dormant', currentPtyId:null})` so the voice command matches the End button. Direct-llm anchors no-op the ptyKill; cc-pty anchors release. The in-flight tool_use gate from the original spec was not added; current behaviour treats voice end as authoritative since the operator just said the words.
- [x] **Utterance queue coalesce (relevance-aware single structured reply).** Phase A shipped 2026-05-26 (Fix 35, direct-llm path). cc-pty speak-queue fix shipped 2026-05-26 (Fix 40). Phase B shipped 2026-06-01 (Fix 57: classifier with follow-up/new/noise/cancel tags, conflict push-back via passed rule set, AbortController plumbing into callVoiceChat so contradiction cancels the in-flight ollama call). Phase C shipped 2026-06-01 (Fix 57: t:'text-input' WS frame flows through the same pendingUserUtterances + runDirectLlmCoalesceLoop pipeline voice uses; cc-pty path routes through ptyInject).
- [x] **Stages 5-12 of `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md`** (codex-reordered). All shipped 2026-05-26 to 2026-05-29: Stage 5 (Fix 36), Stages 6-12 absorbed under Fix 41-49 (sync barrier, freshness metadata, stale/failure surfacing, adaptive walk-back, worker boot payload builder via source-graph-payload, first-attach path, loose-ends handoff gate Fix 47, grooming/escalation watch Fix 48, project_scope_id Fix 49).

## Next after project-anchors spec

- [x] Global panic button shipped. `08-dashboard/components/PanicButton.tsx`, POST /panic, double-ESC, top bar next to voice stop, Ctrl+Alt+. global keybind, three visual states (idle/firing/cooldown).
- [x] Smart compact shipped. Daemon scheduler tick + evaluateTrigger + wrap/fire path live since 2026-05-22. v2 (Fix 36) moved summary authorship to Lex 2026-05-25. Fix 40 fixed cc-pty speak-queue serialisation 2026-05-26 (pending daemon restart). Fix 41 (in-flight) moves all policy out of daemon into Lex.
- [x] Lex dashboard controls. Shipped: `POST /voice/mute`, `POST /voice/unmute`, `POST /voice/stop` routes wired via `handleVoiceControl` factory in `routes.ts:1772-1774`. `broadcastVoiceControl(kind, {bindKey, reason})` pushes the corresponding `t:'voice-mute' / 'voice-unmute' / 'voice-disable'` frame to every connected voice WS. System prompt API_SURFACE at `system-prompt.ts:553-558` exposes the routes to Lex as tools.

## Stream deck (virtual deck in dashboard)

- [x] Arrow tile foreground color: was greyed-out slate, now pure white for visibility.
- [x] Tile-tap focus and Nav-mode key inject. Routed through StreamDeck.App tray (commit `3147c41` in stream-deck repo, `59cfd2e` in DevNeural). Tray app holds the OS focus rights the bridge could not. Daemon writes to `%LOCALAPPDATA%\stream-deck\virtual-input\<sessionId>.in`, app's VirtualInputWatcher dispatches through the same WindowManager.FocusWindow + NavKeymap.InjectFor paths the physical deck uses.
- [x] Workspace resolution: ResolveVSCodeWindowSmart walks cwd segments deepest-to-shallowest so a session launched in a subdir (e.g. `07-daemon`) still resolves the workspace-root VS Code window (`DevNeural`).

## Deferred / future

- Phase 4 Orb data rebind. Force-directed UI shipped; pages-as-nodes data layer awaiting more accumulated wiki content.
- Phase 5 settings audit + personalized recovery docs. Mostly documentation.
- Audio/video binary smoke test post whisper.cpp + ffmpeg install.
- **Phase 7 voice identity bundle** (planned 2026-05-10): pyannote-based speaker diarization so Lex distinguishes primary user voice from third-party / background speech and routes ambient utterances out of the reply path. Same enrolled voice profile doubles as a voice-unlock biometric (with liveness check) for dashboard / Lex auth, augmenting PIN. Bundled with Phase 7 Lex personality fine-tune.

## Bugs / friction (captured 2026-05-13 brainstorm)

- [x] **Dashboard rebuild after panel commits is manual + invisible.** Shipped: `07-daemon/src/dashboard/dashboard-supervisor.ts` (316 lines) owns the lifecycle of `next dev -p 3000`. `runtime_config.dashboard_supervisor_enabled` gates, env `DEVNEURAL_DASHBOARD_SUPERVISOR` fallback, CI=true forces off. Backoff doubles on fast crash, resets on graceful exit. `taskkill /t` on Windows tears the next worker subtree on shutdown. Wired in daemon.ts at line 1373; shutdown closure awaits at line 1480.
- [x] **Bridge cc_session_ids goes empty when worker idle >30s. Fix: make cc_session_id sticky, gated on bridge presence freshness not jsonl mtime.** Sticky latch shipped 602d91e. /clear stuck-phase follow-up shipped 4796aa8 (60s anti-flap window + latch-first ccSessionLookup priority so daemon /sessions cache cannot self-reinforce a stale uuid).
- [x] **Dashboard lock state has no visible indicator. Operator can't tell when /unlock is required.** First pass shipped as Task D top-level `AuthGuard` (commit pending). Mounted at `app/layout.tsx`, polls `GET /auth/status` on 30s tick + visibility/focus events, redirects to `/unlock` on `locked=true`, and surfaces a yellow `Session expired, click to unlock.` banner the moment the state flips. Still open as polish: persistent lock pip + remaining-TTL tooltip in TopBar, explicit "Lock now" affordance, sliding-window refresh.
- [~] **C-4 live verify** (2026-05-13). The blocker called out in the original capture (migration 025 not applied, daemon predated 295feff / d828762 / ae0a973) is resolved: the daemon has restarted many times since, migration 025 is applied, supervises_project_anchor_id is populated on 4bbafb48 -> 391b88f6 (verified 2026-05-29 + 2026-06-01). Remaining work is the actual live `POST /lex/inject-cross-session` call with `caller_brainstorm_id` only against a live worker; gated on a fresh worker spawn. Move to `docs/SMOKE-TEST.md` step 6.7 family on the next live brainstorm.
- [x] Cold-start preload SessionStart hook firing on Lex sessions. Resolved: preload pipeline ships live per `project_lex_cold_start_context_preload.md` memory; sibling index + last-2 distillations + recent turns injected via SessionStart hook. Dashboard toggle off/shadow/live working.
- [~] **First voice-mode response always silent (2026-05-13).** SHIPPED d977816 (2026-05-16): AudioContext now warmed inside the enable-voice click handler so first reply plays. Root cause was autoplay-policy freeze on a context created in a network callback. Pending live smoke-test on real hardware to confirm no regression; if symptom recurs, treat as regression and re-investigate.
- [ ] **WASM/VAD mic init OOM under load (2026-05-13).** Initial fix shipped 637ae73 (pin single-thread WASM + retry button). Open follow-ups: (b) COOP/COEP headers to unlock SharedArrayBuffer + bigger heap, (d) singleton ORT init so VAD remount reuses the existing WASM module instead of re-firing initWasm(). Without (b) and (d), long-running tabs or multi-tab sessions can still accumulate heap pressure and OOM. Smoke test: open dashboard via tailscale, exercise /lex repeatedly (mode switches, page hops), open a second dashboard tab, leave running for >1 hour, watch DevTools console for new VAD init failures. If failures recur post-fix, escalate to (b) + (d). Track as ongoing memory-management concern, not single-bug closeout.

## Captured 2026-05-14 brainstorm

- [x] **Read distilled brainstorm summaries.** Three readers shipped: dashboard past-sessions panel renders `last_summary` per session; HTTP endpoint at `07-daemon/src/dashboard/routes.ts:3395`; CLI helper `npm run dump-distillations` (Fix 60). Storage reference retained below for future schema work. Distillations live in SQLite, not flat files. Storage:
  - DB: `C:\dev\data\skill-connections\index.db`
  - Table: `brainstorm_sessions`
  - Columns: `last_summary` (the prose distillation), `last_summary_ms` (timestamp), `distilled_at`
  - Wiki distillation drafts live in separate `wiki_drafts` table keyed by `brainstorm_id`, column `body_markdown`, status pending/promoted/discarded/auto-promoted/auto-dropped/superseded.

  Three ways to read them:
  1. **Dashboard UI**: past-sessions panel renders `last_summary` per session (cleanest).
  2. **HTTP endpoint**: existing route in `07-daemon/src/dashboard/routes.ts:3395` returns the meeting/brainstorm summary by id (path TBD, confirm before use).
  3. **Direct DB query**: `sqlite3 C:\dev\data\skill-connections\index.db "SELECT id, user_label, datetime(last_summary_ms/1000, 'unixepoch'), substr(last_summary,1,500) FROM brainstorm_sessions WHERE last_summary IS NOT NULL ORDER BY last_summary_ms DESC LIMIT 10;"`. Note: sqlite3 not on PATH in OTLCDEV's bash; use DB Browser for SQLite, or run via `npx better-sqlite3` inline script.

  - [x] dump-to-markdown helper shipped 2026-06-01 (Fix 60). `npm run dump-distillations -- --limit N --out path.md` walks recent rows and writes a single markdown file. Read-only against the live DB; honours `DEVNEURAL_DATA_ROOT`. Default output `C:/tmp/distillations-YYYY-MM-DD.md`.

## Pre-publish (before GitHub release)

- [ ] Comprehensive docs rewrite. Audit + rewrite every README, in-tree note, and how-to so an outside reader can understand: what each subsystem does (daemon, bridge, dashboard, lex, hooks, curator, wiki, orb, stream-deck), how they connect (data flow, IPC, presence files, HMAC tokens, runtime_config), and how to operate them (install, run, troubleshoot, observability). One canonical top-level README pointing into per-subdir READMEs. Captured 2026-05-13 during brainstorm.
- [ ] **Dead-code and dead-reference sweep across the project tree.** Walk every subdir and delete anything that is parked, never imported, never installed, or referenced only by itself. Known starting points: `06-notebooklm-integration/` (research + plan + spec docs + `implementation/` dir, zero runtime imports outside an archived v1 comment), `archive/v1/` (legacy code path, retained "in case", reassess), stale Playwright fixtures, dead screenshots in test-results, abandoned migration scripts, orphaned test artifacts, dead npm deps with no in-tree import. Also strip dangling doc references that point at deleted files/modules. Goal: every line of code, every dependency, every doc page either justifies itself or gets removed. Captured 2026-05-14.
- [ ] Comprehensive smoke-test pass after the cleanup. End-to-end run through every shipped feature on real hardware (voice, push, brainstorm, supervision, projects panel, wiki, orb, stream-deck) so the public release sits on a verified product. Captured 2026-05-14.

## Operational

- [x] Audit and prune `~/.claude/settings.json.*.bak.*` backup files. Six stale backups deleted; `settings.json.bak` kept as canonical recovery point.
- [x] `silence-all-hooks.ps1` redesigned around a native silent-shim.exe. Stdin pipes through, child runs hidden, hook stdout reaches Claude. Build with `dotnet publish` in `07-daemon/scripts/silent-shim`, then `npm run silence-hooks`.
- [x] Bridge `focusWindow` + `injectKey` + nav PS helpers removed (commit `aee3053`). Bridge is now text-only.
- [x] deck-hook.sh double-escape bug fixed at source (stream-deck commit `605688b`). Segment-walk in C# is still useful as a fallback when Claude is launched from a workspace subdirectory.
