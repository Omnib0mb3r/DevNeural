# DevNeural

> Your second brain. Local. Learning. Watching. Surfacing what matters when you need it.

DevNeural is a personal second brain for software work. It captures everything you do in Claude Code, builds a semantic search layer (RAG) over the raw record, compiles transferable insights into a maintained wiki, recommends relevant prior thinking to Claude in real time, learns from what actually works, and surfaces it all through a dashboard you can hit from anywhere via Tailscale.

It runs entirely on your own hardware. By default no data leaves your machine. Two opt-in flags allow Anthropic API for Pass 2 schema fallback and cross-project pattern verification on non-voice content only. Voice brainstorm and meeting content stays host-only in the direct-llm (ollama) runtime; the default cc-pty runtime instead sends it to Anthropic as part of the normal Claude Code conversation, outside that outbound_log tracking. Every off-host call the outbound guard covers is logged in `outbound_log` and shown on the dashboard's Outbound card; see `outbound.md` at the repo root for the canonical list.

DevNeural is **brainstormer-first**. Voice brainstorm conversations are the substrate of the system, not derivative artifacts of project work. Retrieval ranks brainstorms above the wiki, brainstorms never decay, and brainstorm content is the highest-sensitivity privacy class. The wiki is downstream of brainstorming. See `voice-review.md` and `docs/spec/PHASE-TWO-IMPLEMENTATION.md` for the full reframe.

---

## What it is

A second brain has six properties. DevNeural has all six.

| Property | DevNeural |
|---|---|
| **Persistent memory** across sessions, projects, and time | Wiki + RAG layers stored locally, versioned in git |
| **Semantic recall** (you remember the shape of a problem, not the words) | Local embedder + vector search over wiki and raw transcripts |
| **Watches and learns without being asked** | Claude Code hooks + transcript watcher capture continuously |
| **Surfaces relevant prior thinking in real time** | At every prompt, the curator injects the most useful 600 tokens |
| **Compounds with use** | Reinforcement loop: useful injections strengthen, ignored ones decay |
| **Lives entirely on your hardware** | Local LLM (ollama), local embedder (ONNX), local vector store, local wiki |

---

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Daemon: capture, ingest, query, reinforce, lint, setup | done, shipped |
| 2 | v1 burndown: archive 01/02/04, kill monday sync, rewrite top-level docs | done, shipped |
| 3.1 | Daemon API extensions (auth, system metrics, services, sessions, search/all, reminders, notifications, projects/new, dashboard health) | done, shipped |
| 3.2 | Reference corpus pipeline (PDF, image, markdown, DOCX upload + extract + chunk + embed) | done, shipped |
| 3.3 | Session bridge VS Code extension | done, shipped |
| 3.4 | Dashboard frontend (Next.js 15 + Tailwind v4 + Tanstack Query, no PIN gate; trust boundary is the host + Tailscale, only /auth/cross-session-token remains, all panels real, mobile responsive, PWA) | done, shipped |
| 3.5 | Audio + video processing (whisper.cpp + ffmpeg wrappers) | done, shipped (whisper.cpp + ffmpeg binaries installed on OTLCDEV; setup instructions for fresh hosts below) |
| 3.6 | Stream Deck + session detail polish | done in 3.4.2 |
| 3.7 | Notifications + reminders + web push (VAPID) | done, shipped |
| 3.8 | System panel + Tremor sparklines | done, shipped |
| 3.9 | New project flow | done, shipped |
| 3.10 | Daily brief + whats-new rendering | done, shipped |
| 3.11 | PWA scaffold + mobile | done; needs PNG icons (design work, not blocking) |
| 3.12 | Polish pass — sparklines, install prompt, keyboard a11y, sr-only utility | done, shipped |
| 4 | Orb rebind to wiki data model — force-directed graph + /graph endpoint | done, shipped |
| 5 | Settings audit + personalized recovery docs + robust backup pipeline | done, shipped |
| 6 | Notification hook → dashboard permission UI (CC permission/elicitation prompts surface in /sessions with answer buttons) | done, shipped |
| 7 | Lex supervisory voice loop: daemon-PTY hosts a personality-typed Claude Code session; whisper.cpp cuBLAS STT in, Piper TTS out, silero VAD with mute auto-finalize, three voice modes (conversation / notes / push-to-talk), browser voice picker, barge-in. First-class brainstorm_sessions records, source-classed retrieval (`/lex/recall`), fenced-JSON artifact extraction, supervisor primitives, conflict-overlap signal on retrieval. | **shipped**: Slice A (brainstorm_sessions schema + WS pipeline), Slice B (`/lex/recall` source-classed retrieval), Slice C (fenced-JSON artifact extraction for research-note / wiki-draft / project-intent / notes-summary), Slice D (system prompt mode contracts + synthesis directive), Slice E (`/lex/steer` + `/lex/capture` + `/lex/snapshot`), voice UX (mute auto-finalize, AudioContext warm, notes-summary artifact emit, barge-in cooldown), STT-config defence (whisper-bin validator + cuBLAS auto-correct). **Follow-on (Phase Two work track, separately scoped)**: cross-session supervision, awareness broadcaster, personality fine-tune, smart compact, six-section resume, dashboard supervisor. Tracked in `docs/spec/PHASE-TWO-IMPLEMENTATION.md` with wave-by-wave detail. |

See [docs/HANDOVER.md](docs/HANDOVER.md) for what state the repo was in at the most recent session boundary. Active multi-session work is tracked in `docs/HANDOVER.md` plus the spec files under `docs/spec/`.

---

## First-time setup checklist

Run these once on `OTLCDEV` (the host machine) in order. Each step is idempotent; re-running does nothing harmful.

> **Before you start**: read [`outbound.md`](outbound.md) in the repo root for the canonical list of off-host calls. DevNeural is local-first by default; that file is the authoritative inventory of every opt-in flag (Pass 2 schema fallback, cross-project pattern verifier, etc.) that could put a request on the wire. If you would rather review each call type before installing, do it now.

```powershell
# 1. Prereqs (one-shot, see docs/install/01-prerequisites.md for the long version)
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Ollama.Ollama
winget install Microsoft.VisualStudioCode
winget install Tailscale.Tailscale
winget install Anthropic.Claude
winget install Gyan.FFmpeg                                  # Phase 3.5 audio/video, optional
ollama pull qwen3:8b                                        # local LLM

# 2. Clone + build the daemon
git clone https://github.com/Omnib0mb3r/DevNeural C:\dev\Projects\DevNeural
cd C:\dev\Projects\DevNeural\07-daemon
npm install
npm run setup                                               # builds, scaffolds wiki, verifies ollama
npm run install-hooks                                       # registers v2 hooks; backs up settings.json first
npm run dedupe-hooks                                        # optional cleanup of duplicates from other installers

# 3. Build the dashboard for production serve
cd C:\dev\Projects\DevNeural\08-dashboard
npm install --legacy-peer-deps
npm run build                                              # produces 08-dashboard/out/ (prebuild rimraf + next build + SW version stamp)

# 4. Install the session bridge (lets the dashboard send prompts to running Claude terminals)
cd C:\dev\Projects\DevNeural\09-bridge
npm install
npm run build
npm run package
code --install-extension devneural-bridge.vsix

# 5. Schedule the daily backup (CRITICAL: your data root is the irreplaceable thing)
cd C:\dev\Projects\DevNeural\07-daemon
npm run install-backup-task                                 # default: daily 03:00, keep 14 snapshots locally
# Recommended: redirect to OneDrive, an external drive, or a NAS share for off-machine durability:
# npm run install-backup-task -- -BackupRoot "$env:USERPROFILE\OneDrive\devneural-backups"
# Inspect what's currently set: npm run backup-where

# 6. Start the daemon
npm run start                                               # listens on 0.0.0.0:3747, serves the dashboard at /
npm run install-daemon-autostart                           # persist across reboot: Task Scheduler DevNeural-Daemon -> start-daemon.ps1 (npm run start alone does NOT survive a reboot)

# 7. Optional: HTTPS via Tailscale Serve (required for service worker + push notifications + PWA install)
tailscale serve --bg --https=443 http://localhost:3747      # phones hit https://otlcdev.tail-XXXXX.ts.net
```

Then open `http://localhost:3747` in a browser and you're in. There is no PIN gate; the trust boundary is the host plus your Tailscale tailnet.

For Tailscale remote access from your phone, follow [docs/install/TAILSCALE.md](docs/install/TAILSCALE.md). The HTTPS step (7) is required for push and PWA install; plain HTTP works for everything else. For audio/video uploads, follow [docs/install/AUDIO-VIDEO.md](docs/install/AUDIO-VIDEO.md). For full-machine recovery, follow [docs/install/08-personalized-recovery.md](docs/install/08-personalized-recovery.md).

---

## Capabilities at a glance

| Capability | What it does |
|---|---|
| **RAG layer** | Every transcript chunk and uploaded doc embedded into local vector store. Semantic recall by meaning, not keywords. |
| **Learning wiki** | LLM-compiled markdown pages following a `[trigger] → [insight]` schema. Edges are explicit cross-references. |
| **Recommendation engine** | At every Claude prompt, top-relevance page injected as additional context. Below threshold = silence. Better nothing than noise. |
| **Cross-project intelligence** | Insights observed in two or more projects promote to global. The brain spans your work, not one repo. |
| **Reference corpus** | Upload manuals, books, PDFs, images, DOCX. Local OCR + chunking. Audio + video pipeline ships behind whisper.cpp + ffmpeg. |
| **Reinforcement** | Useful injections raise page weight; corrections lower it; unused pages decay. Empirical, not editorial. |
| **Dashboard** | Central hub on port 3747. Sessions, projects, search, system metrics with sparklines, daily brief, reminders, web push, force-directed wiki graph (Orb), and inline answer UI for CC permission/elicitation prompts so you can reply remotely without tabbing back to VS Code. PWA-installable on phone. Tailscale for remote access. |
| **Backup pipeline** | Daily scheduled snapshot of the data root with SQLite atomic capture, manifest, integrity verification, and rotation. |
| **Local-first** | Default LLM is ollama (qwen3:8b). Anthropic API supported as fallback. Zero cost in default config. |
| **Lex (supervisory voice layer)** | Always-available coworker on top of the active worker sessions. Daemon-PTY hosts a `claude` session with a Lex system prompt (four mode contracts, one invariant voice, synthesis directive). Voice loop: whisper.cpp cuBLAS STT, silero VAD with mute auto-finalize, Piper TTS with picker. Three modes: conversation, notes (silent reply, auto-summarises on stop), push-to-talk. Emits structured artifacts inline as fenced JSON; the daemon persists them and fans notes-summary reminders into the reminder system. Source-classed retrieval at `/lex/recall` so canonical wiki outranks pending drafts outranks brainstorm transcripts outranks generic raw outranks reference. |
| **Session-end pipeline** | When any voice/Lex session ends (Stop button, spoken "end session" command, browser close, PTY exit), the daemon force-flushes the project's tail content through the wiki ingest LLM (bypasses the 600-byte periodic floor), refreshes the rolling session summary, and embeds the summary into `raw_chunks` tagged with `kind:'brainstorm-summary'` and `mode:<voice mode>`. The mode tag is the durable marker that distinguishes meeting recordings (`mode:'notes'`) from chat sessions even after the brainstorm row archives. |
| **Reinforcement decay** | Every wiki page weight decays daily (`DEVNEURAL_DECAY_INTERVAL_MS`, default 24h). Pages that never get injected drift toward the archive threshold instead of staying at their last-touched weight forever. Hits boost weight, corrections drop it, decay fades the unused. |
| **Pass 2 ingest fallback** | When the local LLM (`qwen3:8b`) exhausts retries on Pass 2 schema validation, an opt-in fallback (`DEVNEURAL_PASS2_FALLBACK=anthropic`) retries once against Anthropic Haiku. Off by default. Closes the keystone wiki-quality risk on borderline-hardware installs without breaking local-first. |
| **Cross-project verifier** | When a wiki page first gains evidence from a 2nd project, a cheap LLM verification call asks "same recurring pattern, yes/no?" before accepting the cross-project merge. Failing closed flags the page for review instead of silently fusing unrelated patterns that share vocabulary. |
| **Turn-bounded chunking** | Consecutive same-role same-session jsonl lines merge into one vector chunk instead of N. A 20-line assistant turn (text + tool_use + tool_result + text) becomes one chunk, keeping a single thought as a single retrieval unit. Existing per-line chunks remain valid until decay archives them. |
| **KPI dashboard** | Five-row strip on the dashboard home covering every axis of "is the brain working": Size (lines of code, wiki pages, raw chunks, reference chunks), Quality (avg wiki weight, hits/corrections last 7d, flagged for review, cross-project pages), Activity (active CC sessions with phase breakdown, active brainstorms with mode breakdown, artifacts captured), Velocity (commits last 7d), Health (last backup, daemon uptime, embedder calls). Animated count-up on numeric tiles, pulse highlight on growth signals. |

---

## The two layers

DevNeural is built on two complementary layers. Neither alone is sufficient.

**Semantics layer (meaning-based).** Vector embeddings, cosine similarity, two-tier retrieval. This is what lets you recall by intent. "The warehouse layout decision" finds work where you didn't use those words.

**Logic layer (rules-based).** The structured `[trigger] → [insight]` page schema, validation gates on every LLM output, promotion criteria, reinforcement rules, hard editorial rules. This is what keeps the wiki from becoming a junk drawer.

Without semantics: a junk drawer of insights nobody can find. Without logic: a vector store of noise that scores high but means nothing. The combination is what makes the wiki a brain.

See [docs/spec/devneural-v2.md section 7](docs/spec/devneural-v2.md) for the full breakdown.

---

## Architecture

```
Claude Code session(s)
  ├─ hooks (Pre/Post/UserPromptSubmit/Stop/Notification/SessionStart) → hook-runner
  └─ transcripts → ~/.claude/projects/<slug>/<session>.jsonl
                        │
                        ▼
                  ┌─────────────────────────────────────────┐
                  │  07-daemon (long-running, lazy-spawned) │
                  │   capture → embed → ingest → query      │
                  │   reinforce → lint → reconcile          │
                  │   curate at UserPromptSubmit            │
                  │   serves dashboard on port 3747         │
                  └──┬──────────────┬──────────────┬────────┘
                     │              │              │
              POST /api/chat    in-process    on-disk
                     │              │              │
                     ▼              ▼              ▼
                ┌──────┐     ┌──────────┐   ┌──────────────┐
                │ollama│     │ vector + │   │ wiki/ + ref/ │
                │qwen3 │     │ SQLite   │   │ + git log    │
                └──────┘     │ FTS5     │   └──────────────┘
                             └──────────┘
                     ▲
              served at 3747
                     │
              ┌──────────────────────────────────────┐
              │  08-dashboard (Next.js PWA)         │
              │  - reachable via Tailscale          │
              │  - mobile-installable                │
              │  - statically exported, daemon serves │
              └──────────────────────────────────────┘

              ┌──────────────────────────────────────┐
              │  09-bridge (VS Code extension)       │
              │  watches session-bridge/ and pastes  │
              │  queued prompts into terminals       │
              └──────────────────────────────────────┘
```

For the full architecture, read [docs/spec/devneural-v2.md](docs/spec/devneural-v2.md).
For the LLM's standing instructions on writing wiki pages, read [docs/spec/DEVNEURAL.md](docs/spec/DEVNEURAL.md).

---

## Where things live

| Path | What |
|---|---|
| `07-daemon/` | The brain. Capture, ingest, query, lint, HTTP/WS API, dashboard static serve, backup pipeline. |
| `07-daemon/scripts/` | `backup.ps1`, `restore.ps1`, `verify-backup.ps1`, `install-backup-task.ps1`, `dedupe-hooks.ps1`, `silence-all-hooks.ps1` (silent-shim wrap), `silent-shim/` (native invisible launcher), `repair-double-wrapped-hooks.ps1` + `reescape-hook-args.ps1` (one-shot migrations). |
| `08-dashboard/` | Next.js 15 + Tailwind v4 + Tanstack Query. Statically exported; daemon serves the build. |
| `09-bridge/` | VS Code extension that pastes queued prompts into terminals. Phase 3.3. |
| `archive/v1/` | Archived v1 modules (01-data-layer, 02-api-server, 04-session-intelligence). |
| `docs/spec/` | System architecture, schema, phase plans (3, 4, 5). |
| `docs/install/` | Install (01–04), coexistence audit (05), recovery (06, 08), troubleshooting (07), Tailscale, audio/video. |
| `docs/HANDOVER.md` | Current state at most recent session boundary. |
| `INSTALL.md` | Top-level install entry point. |
| `SHIP-CHECKLIST.md` | Production-readiness gate before declaring a build deployable. |

---

## Operations cheat sheet

```powershell
cd C:\dev\Projects\DevNeural\07-daemon

npm run start                       # daemon on :3747 (serves dashboard)
npm run install-daemon-autostart    # persist across reboot (Task Scheduler DevNeural-Daemon -> start-daemon.ps1); npm run start alone does not survive a reboot
npm run status                      # health check across daemon, ollama, hooks, data root
npm run install-hooks               # re-register hooks (idempotent, backs up settings)
npm run dedupe-hooks                # remove duplicate hooks from other installers
npm run backup                      # one-shot snapshot
npm run verify-backup               # PRAGMA integrity_check + JSON parse on latest snapshot
npm run restore                     # restore latest (refuses while daemon is up)
npm run install-backup-task         # daily 03:00, retain 14, configurable target
npm run backup-where                # show current backup target + schedule + last run + snapshots on disk
npm test                            # 703 unit + integration tests (as of 2026-05-16)
```

### Current backup configuration

This install's backup target is set to `C:\Users\michael\OneDrive\devneural-backups` (off-machine via OneDrive sync). Daily at 03:00, keep last 14, scheduled task `DevNeural-Backup`.

To inspect what's currently set without opening Task Scheduler:

```powershell
cd C:\dev\Projects\DevNeural\07-daemon
npm run backup-where
```

To change the target (idempotent, replaces the existing task):

```powershell
npm run install-backup-task -- -BackupRoot "D:\backups\devneural"             # external drive
npm run install-backup-task -- -BackupRoot "\\nas\share\devneural-backups"     # NAS share
npm run install-backup-task -- -BackupRoot "$env:USERPROFILE\Dropbox\devneural" # other cloud sync
npm run install-backup-task -- -Time 04:30 -Keep 30                            # change cadence + retention
```

Also adjustable: `-Source` (data root, default `C:\dev\data\skill-connections`) and `-Time` (HH:mm 24-hour, default `03:00`).

Dashboard:

```powershell
cd C:\dev\Projects\DevNeural\08-dashboard
npm run dev                         # localhost:3000 with rewrite proxy to daemon for development
npm run build                                    # static export to out/, daemon serves it (prebuild rimraf + next build + SW version stamp)
```

---

## How-tos (architecture deep dives)

Sequenced for anyone (or any Lex) rebuilding context on a cold start.
Each doc is the canonical reference for its surface; spec docs under
`docs/spec/` capture the design intent, these capture what is wired
in the daemon today.

- [docs/HOW-TO-supervision-pipelines.md](docs/HOW-TO-supervision-pipelines.md)
  Bridge presence + project anchor reconcile, cross-session injection
  pipeline (HMAC + allowlist + audit), smart compact orchestration,
  event-driven supervision (router + detectors + kill-switch +
  chokidar listener + supervision_mode toggle), brainstorm threading
  (sibling index + Phase 2 preload + N=5 backfill).
- [docs/HOW-TO-dashboard-ux.md](docs/HOW-TO-dashboard-ux.md)
  Global panic button + `Ctrl+Alt+.` keybind + audit panel, Lex
  transcript history panel (rolling 10 turns + thinking placeholder
  + collapse toggle), Past Sessions compact pattern (capped height
  + collapse-to-strip), shared `createCollapseStore` helper,
  responsive top-bar collapse, mic-gate indicator during TTS
  playback.
- [docs/HOW-TO-voice-and-push.md](docs/HOW-TO-voice-and-push.md)
  Voice / TTS speed knob and the five-knob persistence pattern,
  text-input-bypasses-TTS feature note, UUID pronunciation rule,
  reminders → web push end-to-end with cross-restart dedupe ledger,
  5-minute iOS PWA push smoke test, shared supervision warn
  channel.

---

## Why this exists

Because Claude forgets between sessions, and you forget between projects. Together you keep solving the same problems in slightly different ways. DevNeural is the persistent layer that makes both of you smarter at your actual work, while keeping every byte on your own machine.

---

## License

See `LICENSE`.

---

*Michael Collins. Stay on the level.*
