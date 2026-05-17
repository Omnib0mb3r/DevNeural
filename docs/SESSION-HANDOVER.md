# Session handover

> Pick up where the last session left off. Designed to be the first file a new Claude (or you) reads when starting fresh.
> Last updated: 2026-05-10 late evening (Phase Two Wave 2 complete on `phase-two`).

> **State now (2026-05-10, Phase Two Wave 2 complete on `phase-two` branch):** All five days of Wave 2 shipped. Active branch is `phase-two`; worktree at `C:\dev\Projects\DevNeural-phase-two`. Last commit `32fe1bb feat(lex): wave 2 day 5 lex track B + meeting routes`. Tests 142/142 green; tsc clean both daemon + dashboard. **Read `docs/HANDOVER-2026-05-10-phase-two-wave-2-complete.md` first** for the per-day landed work, carry-overs (LexThumbs not yet wired into a render surface, awareness producers not hooked, A/B replay uses in-process LLM not PTY spawn, meeting audio purge job not yet wired), and operational gotchas (Phase Two columns require `setBrainstormPhaseTwo` not `updateBrainstorm`; tests touching `paths.ts` need `vi.resetModules()`). **Resume target on next session:** decide between (a) merging `phase-two` to `master`, or (b) starting Wave 3. Wave 3 is not yet specced beyond the day-2 unified-orb reference at line 1497 of `docs/spec/PHASE-TWO-IMPLEMENTATION.md`.

> **State now (2026-05-09 late PM, KPI dashboard + dashboard hardening):** Three additional commits landed on top of the second-brain strengthening sweep. (a) `13f9612` daemon-restart wait window 60s -> 220s for iPad-over-Tailscale latency. (b) `1a9aedd` + `46e7da7` cache-control headers on dashboard static serve so PWAs no longer white-screen on every dashboard rebuild (HTML no-cache, _next/static immutable, sw.js no-cache; Windows backslash normalization in path checks). (c) `b36bae6` real `claude --resume <session-id>` wired through `/pty/spawn-lex` for past brainstorm session resume (was a stub that just opened a fresh PTY). (d) `89e208a` LOC ticker on dashboard home, walks every registered project via `git ls-files`. (e) `40d1a37` full KPI dashboard: five rows (Size / Quality / Activity / Velocity / Health) backed by a new `/stats/kpi` omnibus endpoint (heavy parts cached 60s server-side; reinforcement signals from `reinforcement.log.jsonl` tail; wiki numbers from frontmatter regex scan; commits via `git log --since=7d` per project; backup mtime walk). KpiStrip component handles animated count-up + pulse on growth signals.

> **State earlier 2026-05-09 PM, second-brain strengthening:** Five-item sweep landed on master. (1) `feat(lex): session-end pipeline` (`e0b1582`) — every voice/PTY end path now force-flushes wiki ingest, refreshes the rolling session summary, and embeds the summary into raw_chunks tagged with mode (`conversation|notes|push-to-talk`). Notes mode = meeting recording marker survives even after the brainstorm row archives. (2) `fix(reinforcement): decay scheduler` (`9606e30`) — `decayInactivePages()` was never called automatically; now runs daily, tunable via `DEVNEURAL_DECAY_INTERVAL_MS`. Closes the silently-broken loop where weights stayed at last-touched value forever. (3) `feat(ingest): pass 2 anthropic fallback` (`41a68f8`) — when local qwen3:8b exhausts retries on Pass 2, retry once against Anthropic Haiku. Opt-in via `DEVNEURAL_PASS2_FALLBACK=anthropic`. ~$0.10/day at borderline local quality, prevents wiki-page drops. (4) `feat(ingest): cross-project verifier` (`d9e80da`) — when an existing page first gains a 2nd project's evidence, run a cheap LLM verification call ("same recurring pattern, yes/no?"). Failing closed sets `flag_for_review` so silent merging across unrelated domains stops. (5) `feat(capture): turn-bounded chunking` (`47a8510`) — consecutive same-role same-session lines merge into one chunk instead of N. Recall on multi-line thoughts no longer splits across N vectors. See `docs/HANDOVER-2026-05-09-second-brain-strengthening.md` for the full tracking doc.

> **State now (2026-05-09 PM):** Dashboard's "Restart Daemon" card was returning `start-daemon.ps1 not found at C:\dev\Projects\DevNeural\scripts\start-daemon.ps1` because `07-daemon/src/dashboard/routes.ts` resolved the script via `process.cwd()`. Task Scheduler launches the daemon with cwd at the project root, not `07-daemon/`, so the lookup missed. Fixed by resolving relative to the compiled module with `fileURLToPath(import.meta.url)` (consistent with how `daemon.ts` and `lifecycle/spawn.ts` already do it). Verified end-to-end: hit `/admin/daemon/restart`, daemon respawned, new PID, /health back to ok=true. Tailscale path now works the same as local.

> **State now (2026-05-09):** Phases 1 through 6 shipped, plus a Lex supervisory voice layer landed across two sessions. This session shipped the post-Slice-A polish (close the active-row leak), Slices B through E (source-classed retrieval at `/lex/recall`, fenced-JSON artifact extraction for research-note / wiki-draft / project-intent / notes-summary, system prompt rewritten as four mode contracts with a synthesis directive, supervisor primitives `/lex/steer` `/lex/capture` `/lex/snapshot`, conflict-overlap signal on retrieval), plus voice UX fixes (mute auto-finalizes the in-progress utterance via a parallel ScriptProcessor capture rig, notes-mode stop emits a `notes-summary` artifact and auto-creates reminders, AudioContext resume on every tts-start), plus a defensive whisper-bin validator that auto-corrects `whisper-cli.exe` to the cuBLAS `whisper-server.exe`. The persistent User-scope `DEVNEURAL_WHISPER_BIN` was corrected at registry level. Phase 7 follow-on work is tracked under `docs/spec/PHASE-TWO-IMPLEMENTATION.md` and the latest `docs/HANDOVER-*.md` file.

> **State as of 2026-05-04 (still relevant):** All Phases 1-5 shipped. Plus a sixth body of work landed: CC's Notification hook is wired to DevNeural's hook-runner, the daemon exposes `/sessions/:id/pending-prompt` (POST/GET/DELETE), and the dashboard's SessionDetail renders the question with auto-parsed numbered answer buttons + free-text fallback. Two silent-shim bugs fixed: cmd-style `""` inner-arg escape replaced with backslash `\"` (bash on Windows treats `""` as empty-string concatenation, which broke spawn), and the install detection regex was anchored so re-runs are idempotent. Two one-shot repair scripts added: `repair-double-wrapped-hooks.ps1` peels stacked shim layers from older runs, `reescape-hook-args.ps1` migrates inner-arg escapes from `""` to `\"`. Audio pipeline verified end-to-end on a generated mp3; `DEVNEURAL_WHISPER_BIN` had been pinned to the deprecated `main.exe` stub and was corrected to `whisper-cli.exe` via `setx` (later this 2026-05-09 session corrected it again to the cuBLAS `whisper-server.exe`). Stream Deck rail in the dashboard now groups tiles by project (multi-session workspaces no longer look like multiple projects) and has a manual refresh button. Transcript role label `assistant` renamed to `lex`.

---

## Where we are

DevNeural v2 is a local-first second brain: capture, semantic RAG, learning wiki, real-time recommendation, reinforcement, and a central dashboard. Phases 1 - 3.x done. The full loop "host → daemon → dashboard → bridge → claude terminal" is closed; next concrete work is whatever the user identifies as the next bug.

## TL;DR

- **Identity is "second brain."** Not a metaphor. Six properties: persistent memory, semantic recall, watches without being asked, surfaces in real time, compounds with use, lives on local hardware. See `docs/spec/devneural-v2.md` section 0.
- **Two layers: semantics + logic.** Semantics = embeddings, vector search, fuzzy recall. Logic = `[trigger] → [insight]` schema, validation, promotion rules, hard editorial rules. Both required. See section 7.
- **Read first:** `README.md` (top-level), then `docs/spec/devneural-v2.md` for architecture, then `docs/spec/DEVNEURAL.md` for the wiki schema, then this file.
- **Phase status:** 1, 2, 3.1 - 3.12 done. 4 (orb) done. 5 (settings audit + autostart + backup tasks) done. 6 (Notification → permission UI) done.
- **Today's later shipments (2026-05-04, post-handover original):**
  - Notification hook: hook-runner handles `notification` phase. Daemon: new `pending-prompt` module + endpoints. Dashboard: PendingPromptPanel in SessionDetail with auto-parsed numbered choices + free-text fallback, dismiss button. Phase override to `permission` when pending. Auto-clears on user_prompt or session_stop or explicit DELETE.
  - silent-shim escape: `""` -> `\"` (bash safety). Detection regex anchored. Two repair scripts added.
  - Audio pipeline: `DEVNEURAL_WHISPER_BIN` corrected from `main.exe` (deprecation stub) to `whisper-cli.exe`. Verified extractAudioTranscript ok on a 2s sine mp3.
  - Stream Deck rail: groups tiles by project_slug; manual refresh button below "new session".
  - Transcript role label: `assistant` -> `lex`.
- **Earlier shipments same day (still relevant context):**
  - Wiki backfill from history complete (168MB / 180 jsonl files, 116 wiki pages indexed, 5185 raw chunks, /graph returns 81 edges).
  - Orb rewrite: curved bezier edges + custom particles drawn in same closure, screen-stable widths, breathing glow, animated promoted ring, isolation-pull + global-gravity forces, connected-subgraph framing.
  - Wiki search: per-collection grouped sections + per-section pagination, wiki-page modal with Pattern/Evidence/Cross-refs/Log + clickable session UUIDs in evidence + Related Transcripts vector search.
  - Session detail: terminal-styled transcripts (`> lex` / `> you` / `> tool`), full-jsonl scan when `?q=` is set so search hits found anywhere highlight properly.
  - Stream Deck Nav mode: 5x3 hardware-mirror grid with mic + arrows + numbers, owns its own bezier + particles.
  - Session-bridge: auto-detects Claude terminal via Win32 process-tree walk (no manual mapping). Strict, never auto-injects into unrelated shells. Per-workspace offset persistence so VS Code reload doesn't replay backlog.
  - Daemon autostart Task Scheduler entry installed and verified (logon trigger + 5-min watchdog repeat with cheap /health probe short-circuit).
  - PWA icons generated, off-site backup task script ready, whisper.cpp Release/ fallback path so audio uploads auto-resolve.
- **Branch:** `master`. All work is on master, no feature branches.
- **Local-first:** ollama with `qwen3:8b` is the LLM. No API keys required. Anthropic SDK installed, used only if `DEVNEURAL_LLM_PROVIDER=anthropic`.
- **Daemon binds `0.0.0.0:3747` by default** so Tailscale routes in. `DEVNEURAL_BIND=127.0.0.1` reverts to local only.
- **No em dashes anywhere.** Per global CLAUDE.md. Use periods, commas, colons, semicolons, parens, hyphens. Applies to chat output, code comments, commit messages, docs.
- **No AI co-author tags** in commits. Ever.

---

## Phase order and status

| # | Scope | Status | Spec / location |
|---|---|---|---|
| 1 | Daemon foundation (capture, ingest, query, reinforce, lint, setup) | done, pushed | `docs/spec/devneural-v2.md`, `07-daemon/` |
| 2 | v1 burndown (archive 01/02/04, kill monday, rewrite top-level docs) | done, pushed | `archive/v1/` |
| **3.1** | **Daemon API extensions** (auth, system metrics, services, sessions, search/all, reminders, notifications, projects/new, dashboard/health, dashboard/daily-brief) | **done, pushed** | `07-daemon/src/dashboard/` |
| **3.2** | **Reference corpus pipeline** (PDF, image, markdown, DOCX upload + extract + chunk + embed) | **done, pushed** | `07-daemon/src/reference/` |
| **3.3** | **Session bridge VS Code extension** | **done, pushed** | `09-bridge/` |
| **3.4** | **Dashboard frontend (Next.js + Tailwind v4 + Tanstack Query, PIN auth, all panels real)** | **done, pushed** (3.4.1-3.4.6) | `08-dashboard/` |
| 3.5 | Audio + video processing (whisper.cpp + ffmpeg) | NOT STARTED — needs whisper.cpp + ffmpeg binaries installed on OTLCDEV before code can be validated | spec |
| **3.6** | **Stream Deck + session detail polish** | **done in 3.4.2** | `08-dashboard/components/{StreamDeck,SessionDetail,SendPromptForm}.tsx` |
| **3.7** | **Notifications + reminders + web push** | **done, pushed** (VAPID, push subscribe, service worker push handler) | `07-daemon/src/dashboard/push.ts`, `08-dashboard/components/PushSubscribeButton.tsx` |
| **3.8** | **System panel + metrics charts** | **basic version done in 3.4.4**; sparkline charts (Tremor) deferred to 3.12 polish | `08-dashboard/components/SystemPanel.tsx` |
| **3.9** | **New project flow** | **done in 3.4.4** | `08-dashboard/components/NewProjectModal.tsx` |
| **3.10** | **Daily brief + whats-new rendering** | **done in 3.4.1**; inline markdown renderer; the LLM-driven generator already exists in the lint cycle which writes wiki/whats-new.md | `08-dashboard/components/DailyBrief.tsx` |
| 3.11 | PWA polish + mobile | scaffold done in 3.4.6 (manifest + service worker + mobile tab bar); needs real PNG icons (192/512) — design work, not code | `08-dashboard/public/{manifest.json,sw.js}` |
| 3.12 | Polish pass | TODO — Tremor sparklines on System panel, install prompt for PWA, prefers-reduced-motion verification, axe sweep on every route | spec |
| 4 | Orb rebind to wiki data model | spec done, deferred | `docs/spec/phase-4-orb.md` |
| 5 | Settings audit, finalizes personalized install docs | spec done, deferred | `docs/spec/phase-5-settings-audit.md` |

---

## Recent commits

```
2e9946e  docs: handover update covering P3.4 + P3.7
1bf3df8  fix(08-dashboard): align DailyBrief client with daemon's response shape
5b2ac9c  feat(07-daemon,08-dashboard): P3.7 web push notifications via VAPID
829b2d7  feat(08-dashboard): P3.4.6 mobile responsive layout + PWA manifest + service worker
7ec706b  feat(08-dashboard): P3.4.5 reminders page + command palette + lock action
95cef49  feat(08-dashboard): P3.4.4 projects grid + new-project modal + system panel
954d409  feat(08-dashboard): P3.4.3 wiki search + reference upload + corpus list
e006aa9  feat(08-dashboard): P3.4.2 sessions table + detail + send-prompt steering
59dd078  feat(08-dashboard): P3.4.1 Next.js scaffold + auth + layout shell + home brief
37ba4a9  docs(08-dashboard): post-mortem closing P3.4 design pass
f1b4b73  feat(08-dashboard): P3.4 design pass via design-website skill
4707385  feat(09-bridge): P3.3 session bridge VS Code extension
253090e  feat(07-daemon): P3.2 reference corpus pipeline
6b6c1eb  feat(07-daemon): P3.1 dashboard API extensions
59013a6  chore(burndown): phase 2 complete
345fafb  docs(spec): lock v2 architecture and wiki schema
```

53/53 unit tests pass on the daemon. Dashboard build passes (12 routes prerender static, 1 dynamic /sessions/[id]).

---

## What was done in Phase 3 (sub-phases 3.1, 3.2, 3.3)

### Phase 3.1: Daemon API extensions (commit `6b6c1eb`)

New module `07-daemon/src/dashboard/`:
- `auth.ts` — PIN authentication. Bcrypt-hashed PIN at `dashboard/auth.json`. Signed session cookie (HMAC-SHA256, per-install secret). Lockout after 5 wrong PINs in 60s for 5 minutes. First-run = no PIN means open access.
- `system-metrics.ts` — CPU (sampled %, load avg), memory, disks (PowerShell on Windows), process info, ollama reachability, data root size with 60s cache.
- `services.ts` — config-driven status manifest at `dashboard/config.jsonc`. Defaults: daemon, ollama, wiki git, tailscale, internet. Per-check kind (http, file, cmd). Returns rollup ok/warn/fail.
- `sessions.ts` — lists Claude sessions on host by reading `~/.claude/projects/<slug>/<sid>.jsonl`. Per-session detail with rolling summary, current task, last N transcript chunks (tail-read, never full file). Queues prompts to `session-bridge/<sid>.in`.
- `daily-brief.ts` — surfaces `wiki/whats-new.md` plus structured summary.
- `search-all.ts` — unified search over wiki_pages + raw_chunks + reference_chunks. Merge by score with source tag.
- `reminders.ts` — append-only jsonl event log replayed into current state. Create/update/complete/uncomplete/archive/delete.
- `notifications.ts` — append-only jsonl with event-bus emission. Severity (info/warn/alert), source tag, dismiss op. Web push delivery deferred.
- `projects-new.ts` — clones `github.com/Omnib0mb3r/dev-template`, fills `devneural.jsonc`, opens VS Code on host.
- `routes.ts` — registers every endpoint on Fastify with auth pre-handler.

Daemon now binds `0.0.0.0:3747` by default. New deps: `bcryptjs`, `@fastify/cookie`, `@fastify/multipart`, `@types/bcryptjs`.

### Phase 3.2: Reference corpus pipeline (commit `253090e`)

New module `07-daemon/src/reference/`:
- `chunk.ts` — paragraph-aware chunking, sentence-fallback for oversize paragraphs. Target 800 chars, 100-char overlap, min 200 (smaller merge into neighbors).
- `pdf.ts` — `pdf-parse` for text extraction. Warns when output looks scanned.
- `image.ts` — `tesseract.js` OCR (English default).
- `store.ts` — `ReferenceStore` class. Owns the `reference_chunks` in-process vector store collection (not Chroma DB), `reference_meta` SQLite table, `reference_fts` FTS5 virtual table. Detects kind from extension.
- `process.ts` — `ingestUpload` pipeline. Saves original, extracts text, chunks, embeds, persists `chunks.jsonl`, builds FTS index.

Endpoints:
- `POST /upload` (multipart): file + optional `project_id` + optional `tags`. Single-pass parts iterator (field order doesn't matter). 100MB default cap (`DEVNEURAL_UPLOAD_MAX_BYTES`).
- `GET /reference` — list docs with optional `project_id` filter.
- `GET /reference/:doc_id` — per-doc detail.

`/search/all` extended to include `reference_chunk` source.

Storage:
```
c:/dev/data/skill-connections/reference/
  docs/<doc-id>/{original.<ext>, text.md, chunks.jsonl}
  images/<doc-id>/...
```

Audio/video deferred to Phase 3.5. New deps: `pdf-parse`, `tesseract.js`, `mammoth`, `@types/pdf-parse`.

### Phase 3.3: Session bridge VS Code extension (commit `4707385`)

New module `09-bridge/` (VS Code extension, local install only).

- `09-bridge/src/extension.ts` — activates on VS Code startup, polls `session-bridge/*.in` every 750ms with persisted byte-offset reader. Parses BridgeMessage JSON lines: `{queued_at, text}` sends to terminal, `{queued_at, action: "focus"}` brings window forward. Picks target terminal by case-insensitive substring match against pattern (default `claude`). Multi-window VS Code: each window only acts on messages whose session_id maps via `session-state/<id>.meta.json` to a cwd starting with this window's workspace folder.

Configuration (`devneural.bridge.*`):
- `enabled` (default true)
- `dataRoot` (must match daemon's `DEVNEURAL_DATA_ROOT`)
- `terminalNamePattern` (default `claude`)

Commands: `Bridge Status`, `Toggle Bridge`, `Pick Claude Terminal for This Window`.

Install:
```powershell
cd C:/dev/Projects/DevNeural/09-bridge
npm install
npm run build
npm run package
code --install-extension devneural-bridge.vsix
```

End-to-end loop now closes:
```
Dashboard / curl POSTs prompt to /sessions/<id>/prompt
  → daemon writes JSON line to session-bridge/<id>.in
  → bridge reads new offset, picks terminal, sendText(text, addNewLine=true)
  → Claude in the terminal sees the prompt as if typed.
```

---

## What's next

Phase 3 is substantively complete. What's actually left:

### 3.5 Audio + video processing (NEEDS BINARIES)

Daemon side. The reference pipeline currently handles PDF, image, markdown, DOCX. Audio and video need:

- **whisper.cpp** built locally on OTLCDEV (`base.en` default model). Wrapper TS module at `07-daemon/src/reference/audio.ts` to spawn the binary on incoming uploads.
- **ffmpeg** in PATH. Wrapper at `07-daemon/src/reference/video.ts` to extract audio (and optionally sample frames every N seconds for OCR) before feeding to whisper.
- Wire both into `process.ts` dispatcher kind detection.

This is implementation + binary install. The code skeleton can be written without testing, then validated on OTLCDEV after `winget install Gyan.FFmpeg` and a whisper.cpp build.

### 3.11 PWA icon assets (design work, not code)

`08-dashboard/public/icons/icon-192.png` and `icon-512.png` are referenced from the manifest but not yet created. Real PNG icons need design (the violet brain mark from the dashboard wordmark, exported at both sizes with `purpose: "any maskable"` safe area). Out of scope for a code agent.

### 3.12 Polish pass

- Add Tremor `<SparkAreaChart>` to System panel for CPU/memory trend lines (last 60 samples)
- Add a beforeinstallprompt listener + "install dashboard" affordance on mobile
- Verify `prefers-reduced-motion` shortens every animation across the app
- Run axe via Playwright on every route and fix any criticals
- Replace lingering `text-[11px]` arbitrary classes with `text-nano` utility for consistency

### Phase 4 (Orb rebind)

Explicitly deferred. Spec at `docs/spec/phase-4-orb.md`. The dashboard's `/orb` route is a placeholder card. Phase 4 plugs the wiki graph data model into a force-directed visualization that lands in the same panel.

### Phase 5 (Settings audit)

Personalized. Spec at `docs/spec/phase-5-settings-audit.md`. Walks through every config knob in the daemon and the dashboard and produces a finalized `INSTALL.md` for a fresh OTLCDEV install. Needs the user to walk through it interactively.

## Where the dashboard lives now

```
08-dashboard/
  app/                  # Next.js App Router
    layout.tsx          # root: fonts, providers, service worker
    page.tsx            # Home (daily brief)
    unlock/, set-pin/   # PIN auth pages (Suspense-wrapped)
    sessions/, sessions/[id]/
    wiki/, projects/, system/, reminders/, orb/
  components/           # AppShell, TopBar, StreamDeck, RightRail, VitalsRibbon,
                        # CommandPalette, DailyBrief, SessionsTable, SessionDetail,
                        # SendPromptForm, WikiSearch, UploadModal, ReferenceList,
                        # ProjectsGrid, NewProjectModal, SystemPanel, RemindersPanel,
                        # PushSubscribeButton, RegisterServiceWorker, Icon, StatusDot, PinForm
  lib/
    daemon-client.ts    # typed wrappers for every daemon endpoint
  public/
    manifest.json       # PWA manifest
    sw.js               # service worker (install/activate/push/notificationclick)
  middleware.ts         # cookie presence gate; daemon does signature verification
  next.config.mjs       # rewrites /auth/*, /sessions/*, /dashboard/*, /push/*, etc to localhost:3747
  app/globals.css       # tokens.css inlined under @theme directive (tailwind v4)
  mockup/               # original v4 static mockup, kept as reference baseline
  references/           # reference doc analyses from design pass + verification artifacts
```

Run with the daemon up:

```powershell
cd C:/dev/Projects/DevNeural/07-daemon
npm run start
# in a separate terminal
cd C:/dev/Projects/DevNeural/08-dashboard
npm run dev
# open http://localhost:3000 — first run prompts to set PIN, subsequent prompts to unlock
```

For prod (single-origin, daemon serves the static export): `npm run build` then point the daemon at `08-dashboard/out` as a static dir. That wiring is part of 3.12 polish.

---

## Critical user preferences (durable, honor every session)

- **Be direct, not verbose.** Called out multiple times for sprawling answers when yes/no would do.
- **Don't barrel into action.** Questions deserve answers, not action. The user explicitly said: "A question is NOT authorization to act. Sometimes the user wants to talk something out first."
- **No em dashes. Anywhere. Ever.**
- **Bluntness over politeness.**
- **Root cause first.** Don't suggest workarounds unless truly the only option.
- **Full file paths.** `C:/dev/Projects/...` not `foo/bar.ts`.
- **Local-first.** No API costs. Local LLM (ollama). Local embedder. Local vector store. No cloud services.
- **Sellability matters.** Decisions consider product polish.
- **Privacy matters.** All data local on `OTLCDEV`.
- **Tailscale is the network perimeter** for remote access.

---

## Important architectural choices

- **Custom in-process vector store, not Chroma DB.** `07-daemon/src/store/vector-store.ts` is a linear cosine scan with a persistent file format. Fast enough for single-developer volumes. The on-disk directory is still named `chroma/` for historical reasons; the runtime has no Chroma dependency.
- **Local LLM via ollama.** Default `qwen3:8b`, fallback `qwen2.5:7b-instruct`. Set via `DEVNEURAL_OLLAMA_MODEL`.
- **MiniLM embedder via @xenova/transformers.** 384-dim, ONNX. Cached at `c:/dev/data/skill-connections/models/`.
- **SQLite + FTS5** via `better-sqlite3`. WAL mode.
- **Wiki is git-versioned markdown on disk.** Every ingest auto-commits. Hand-readable.
- **Hooks lazy-spawn the daemon.** No need to start manually after install.
- **Five-layer self-loop guards** prevent the daemon from observing its own LLM-driven sessions.
- **Daemon binds 0.0.0.0 by default** for Tailscale. Override with `DEVNEURAL_BIND=127.0.0.1` if you want strict localhost.
- **Reference corpus is a third vector-store collection (`reference_chunks`)** alongside `raw_chunks` and `wiki_pages`. Same custom in-process vector store as the rest of the daemon (not Chroma DB). Insights still only come from your own work; uploaded docs are searchable but never become wiki pages.

---

## What's actually testable end-to-end today (no UI)

```powershell
# Status
cd C:/dev/Projects/DevNeural/07-daemon
npm run status

# Start the daemon manually (or let hooks lazy-spawn it)
npm run start

# Hit the API
curl http://127.0.0.1:3747/health
curl http://127.0.0.1:3747/dashboard/health
curl http://127.0.0.1:3747/sessions
curl http://127.0.0.1:3747/services
curl -X POST -H "Content-Type: application/json" -d '{"q":"my query"}' http://127.0.0.1:3747/search/all
curl -X POST -H "Content-Type: application/json" -d '{"title":"test reminder"}' http://127.0.0.1:3747/reminders

# Upload a reference doc
curl -F "project_id=warehouse-sim" -F "tags=manual,conveyor" -F "file=@C:/path/to/manual.pdf" http://127.0.0.1:3747/upload

# Send a prompt to a running Claude session (after installing the bridge)
curl -X POST -H "Content-Type: application/json" -d '{"text":"summarize where we are"}' http://127.0.0.1:3747/sessions/<session-id>/prompt

# Read the wiki directly (markdown on disk)
ls C:/dev/data/skill-connections/wiki/pending/
ls C:/dev/data/skill-connections/wiki/pages/
```

---

## Open questions / pending decisions

1. **Phase 3.4 dashboard frontend: when to start?** Phases 3.1, 3.2, 3.3 done. User has not yet authorized the Next.js scaffold.
2. **Project status board (Kanban)** scope inside 3.4. Stage source of truth stays `devneural.jsonc`. Confirm before building.
3. **Self-update mechanism for the daemon.** Currently `git pull && npm install && npm run build`. Could automate. Deferred.
4. **Reference-corpus image processing:** tesseract default. Vision model upgrade is opt-in via env, lands later.
5. **Daily brief generator:** local Qwen vs hybrid (Haiku for the brief only). User committed to local-only.
6. **Scanned PDF OCR fallback:** currently extracts only existing text and warns. Rasterize-then-OCR fallback (pdf2pic + tesseract) is a future polish item.
7. **PWA push notifications:** deferred to 3.7. Need VAPID keys generated + service worker.
8. **Multi-window session targeting:** the bridge falls back to "all windows try" when `session-state/<id>.meta.json` doesn't exist yet. Acceptable for solo use.

---

## Where to read what

| If you need to | Read |
|---|---|
| Understand the system | `docs/spec/devneural-v2.md` |
| Understand the wiki schema the LLM follows | `docs/spec/DEVNEURAL.md` |
| Install the system | `INSTALL.md` then `docs/install/04-step-by-step.md` |
| Recover from a bad state | `docs/install/06-recovery-and-reconstruction.md` |
| Fix a specific symptom | `docs/install/07-troubleshooting.md` |
| Design phase 3 dashboard | `docs/spec/phase-3-dashboard.md` |
| Design phase 4 orb | `docs/spec/phase-4-orb.md` |
| Run phase 5 settings audit | `docs/spec/phase-5-settings-audit.md` |
| Read the daemon code | `07-daemon/src/` |
| Read the bridge code | `09-bridge/src/extension.ts` |
| Run the daemon | `cd 07-daemon && npm run setup` then `npm run start` (or let it lazy-start) |
| Check daemon health | `cd 07-daemon && npm run status` |
| Install the bridge | `cd 09-bridge && npm install && npm run build && npm run package && code --install-extension devneural-bridge.vsix` |

---

## How the user works (style notes)

- Types fast, doesn't always proofread. Treat typos as obvious; don't ask for clarification on simple ones.
- "Move on" / "next" = proceed to next phase or step without ceremony.
- "Lets keep talking" / "table that" = no action yet, conversation mode.
- "Don't build yet" = capture in a doc, do not implement.
- Approval cues: "yeah," "ok," "go," "do it," "perfect," "continue," "cook." These authorize action.
- Frustration cues: "im asking a simple fucking question," "dont be lazy," "just do it." When you see these, you've been verbose or evasive. Trim and act.
- The user often pastes content from other sessions. Treat pasted content as input, not as the user's authoring.

---

## Known gotchas

- **Windows `kill $!` in bash does NOT kill node.exe.** Kills the bash subshell. Use `taskkill /F /PID <pid>`. I orphaned daemons twice doing this.
- **`CLAUDE_CODE_ENTRYPOINT`** can be `claude-vscode` (added to allowed list in self-loop guards). Don't remove.
- **Hook stdout becomes additional context** in Claude. Anything written to stdout from `hook-runner.ts` lands in the prompt. Be careful.
- **Daemon log can grow forever** in v1. No rotation yet. Manual truncate if huge.
- **Wiki git auto-commit** runs on every ingest. If something breaks the wiki repo (manual edit, merge conflict), every subsequent ingest fails the commit step but the page write still succeeds. Check `daemon.log` for git errors.
- **Initial corpus seed** runs in background on first daemon launch IF ollama is configured AND not already seeded. State at `corpus-seed.state.json`. Force re-run with `POST /reseed`.
- **Multipart upload field order:** the `/upload` endpoint uses a single-pass parts iterator. Field order in the multipart body does not matter (early bug fixed in P3.2).
- **Bridge target terminal:** uses substring match on terminal name (default `claude`). If your Claude terminal has a different name, run `DevNeural: Pick Claude Terminal for This Window` in the command palette.
- **Bridge multi-window routing:** falls back to "all windows attempt" if `session-state/<id>.meta.json` does not exist. The session summarizer creates these files; new sessions may take a few minutes before the meta exists.
- **Daemon now binds 0.0.0.0:3747** to allow Tailscale routing. If you want strict localhost: `DEVNEURAL_BIND=127.0.0.1`.

---

## What's NOT done that some might expect

- **Dashboard frontend:** Phase 3.4. Endpoints exist, no UI yet.
- **Audio + video processing:** Phase 3.5. PDF / image / markdown / DOCX work today.
- **Web push notifications:** Phase 3.7. Storage works, push delivery doesn't.
- **Orb rebind:** Phase 4. Old v1 orb code unchanged in `03-web-app/`.
- **05-voice-interface:** untouched, will reshape later.
- **06-notebooklm-integration:** untouched, will reshape later.
- **Autostart on Windows boot:** documented as manual Task Scheduler entry. A polished install path is part of Phase 8.
- **Personalized settings audit:** Phase 5. Install docs hold structure; personalized contents deferred.
- **Project status board (Kanban):** spec'd as part of Phase 3.4 dashboard. Replaces dead monday integration. UI not built.
- **Scanned PDF OCR fallback:** PDFs that are image-only get warned, not auto-OCR'd. A future polish task.

---

## How to start the next session productively

1. Read this file.
2. Read the most recent commit message: `git log -1`.
3. If the user hasn't given direction yet, ask "Phase 3.4 dashboard frontend next, correct?" and wait.
4. If the user gives a direction, follow it. Don't re-litigate the spec.

---

*Michael Collins. Stay on the level.*
