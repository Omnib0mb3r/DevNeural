# DevNeural

> Your second brain. Local. Learning. Watching. Surfacing what matters when you need it.

DevNeural is a personal second brain for software work. It captures everything you do in Claude Code, builds a semantic search layer (RAG) over the raw record, compiles transferable insights into a maintained wiki, recommends relevant prior thinking to Claude in real time, learns from what actually works, and surfaces it all through a dashboard you can hit from anywhere via Tailscale.

It runs entirely on your own hardware. By default no data leaves your machine. Two opt-in flags allow the Anthropic API for Pass 2 schema fallback and cross-project pattern verification on non-voice wiki content only; both are off by default. Every off-host call the outbound guard covers is logged in `outbound_log` and shown on the dashboard's Outbound card; see `outbound.md` at the repo root for the canonical list.

Lex, the voice layers and every supervisor session are headless `claude` sessions on your Claude subscription. No Anthropic API key is read anywhere on that path (pinned by `07-daemon/tests/no-anthropic-api.test.ts`), and the daemon strips `ANTHROPIC_API_KEY` from every session it spawns so a session can never flip from the subscription to per-token billing.

DevNeural is **brainstormer-first**. Voice brainstorm conversations are the substrate of the system, not derivative artifacts of project work. Retrieval ranks brainstorms above the wiki, brainstorms never decay, and brainstorm content is the highest-sensitivity privacy class. The wiki is downstream of brainstorming. See `docs/archive/voice-review.md` and `docs/archive/spec/PHASE-TWO-IMPLEMENTATION.md` for the original reframe.

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

| 8 | Voice layers: Layer 1 voice (one headless haiku `claude` per brainstorm, spawned before the brain, personality and manner only, fail-safe forward), Layer 2 brain (opus `claude`, scoped to one supervised worker), Layer 3 workers. Barge that stops first and decides second, delivery verbs (repeat, slower, louder), AI-interpreted controls with one mechanical panic phrase, plan approval and dispatch confirm by voice, continuous TTS stream. | **shipped 2026-09-22** (`docs/spec/LAYER-1-CONTROL.md` v3) |
| 9 | Context lifecycle (Phase C): the worker writes its handover, Lex vets and corrects it visibly in the file, the operator approves by voice, one seed after the clear; handovers at session end and after a crash from the transcript trail; Lex clears herself behind a structural vet, a live fact check and an outside judge; Layer 1 clears by respawn with a recent-talk ring; a rich context pack on every Lex cold start; one `auto_clear_mode` switch; a context gauge with the auto-clear point on every session surface. | **shipped 2026-09-22** (`docs/spec/SMART-COMPACT.md` section 5) |

See [docs/HANDOVER.md](docs/HANDOVER.md) for what state the repo was in at the most recent session boundary. Active multi-session work is tracked in `docs/HANDOVER.md` plus the spec files under `docs/spec/`. Known bugs live in [BUGS.md](BUGS.md) (read the index block first); every shipped fix has a row in [FIXES.md](FIXES.md).

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
| **Local-first** | Default wiki LLM is ollama (qwen3:8b); the Anthropic API is an opt-in fallback for wiki ingest only. Lex and the voice layers run as `claude` sessions on your subscription. Zero API cost in the default config. |
| **Lex (three voice layers)** | Layer 1 is the voice: one headless haiku `claude` per brainstorm, no tools, thinking off, spawned before the brain so it is warm first; it knows how to talk (first person, like a person, never a file name or symbol aloud) and rebuilds its knowledge every turn from a `[live]` block (brain state, worker phase, last said, pending plan or dispatch or handover, the recent talk). Layer 2 is the brain: an opus `claude` scoped to exactly one supervised worker, acting on current state, driving the worker and the context lifecycle. Layer 3 is the worker. Voice loop: whisper.cpp cuBLAS STT, silero VAD, Piper TTS on one continuous stream per reply. Barge stops the sound at once, then Layer 1 decides finish, answer then finish, or rethink. Controls are interpreted by the voice (mute, stand by, repeat, slower, louder, approve, reject); only the panic phrase is mechanical. Source-classed retrieval at `/lex/recall`. Design of record: `docs/spec/LAYER-1-CONTROL.md`. |
| **Context lifecycle** | Every layer clears its own context on one `auto_clear_mode` switch. Worker: at the setpoint Lex asks for a handover, the worker stops at a safe point and writes it, Lex vets and corrects it visibly in the file, the operator approves by voice, the worker clears and gets that one seed, Lex trail-confirms it resumed. Lex: writes the handover for her fresh self; the daemon vets it, fact-checks it against live state (the worker's real HEAD, the plan file, pending items) and asks an outside judge; then clears her and boots her on the handover plus a rich context pack. Layer 1: respawns at a quiet moment, the recent-talk ring carries the thread. Handovers are also written at every session end and recovered from the transcript after a crash; all are timestamped and browsable. Design of record: `docs/spec/SMART-COMPACT.md` section 5. |
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

See [docs/spec/FUNCTIONAL-SPEC.md](docs/spec/FUNCTIONAL-SPEC.md) for the current system contract and [docs/archive/spec/devneural-v2.md section 7](docs/archive/spec/devneural-v2.md) for the original breakdown.

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

The voice layers sit on top of this: the dashboard's voice client talks to the daemon over a WebSocket; the daemon runs Layer 1 (voice) and Layer 2 (brain) as headless `claude` sessions in daemon-owned PTYs, and Layer 3 workers are the ordinary Claude Code sessions the supervisor hooks already watch.

For the current system contract, read [docs/spec/FUNCTIONAL-SPEC.md](docs/spec/FUNCTIONAL-SPEC.md); for a one-page map of the layers, [docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md). The original architecture draft is archived at [docs/archive/spec/devneural-v2.md](docs/archive/spec/devneural-v2.md) and the wiki schema the LLM follows at [docs/archive/spec/DEVNEURAL.md](docs/archive/spec/DEVNEURAL.md) (the live copy is `wiki/DEVNEURAL.md` in the data root).

---

## Where things live

| Path | What |
|---|---|
| `07-daemon/` | The brain. Capture, ingest, query, lint, HTTP/WS API, dashboard static serve, backup pipeline. |
| `07-daemon/scripts/` | `backup.ps1`, `restore.ps1`, `verify-backup.ps1`, `install-backup-task.ps1`, `dedupe-hooks.ps1`, `silence-all-hooks.ps1` (silent-shim wrap), `silent-shim/` (native invisible launcher), `repair-double-wrapped-hooks.ps1` + `reescape-hook-args.ps1` (one-shot migrations). |
| `08-dashboard/` | Next.js 15 + Tailwind v4 + Tanstack Query. Statically exported; daemon serves the build. |
| `09-bridge/` | VS Code extension that pastes queued prompts into terminals. Phase 3.3. |
| `archive/v1/` | Archived v1 modules (01-data-layer, 02-api-server, 04-session-intelligence). |
| `docs/spec/` | Design of record: FUNCTIONAL-SPEC, LAYER-1-CONTROL (voice layers), SMART-COMPACT (context lifecycle), PROJECT-ANCHORS, EVENT-DRIVEN-SUPERVISION, LEX-AUTONOMY-PAYLOAD-SPEC, PANIC-BUTTON and the other live specs. |
| `docs/superpowers/plans/` | Executed implementation plans; a plan moves to `docs/archive/plans/` once every task in it has landed. |
| `docs/archive/` | Superseded handovers, plans, specs and postmortems, kept for provenance. Nothing there describes the current build. |
| `docs/install/` | Install (01 to 04), coexistence audit (05), recovery (06, 08), troubleshooting (07), Tailscale, audio/video. |
| `docs/HANDOVER.md` | Current state at the most recent session boundary. |
| `BUGS.md` / `FIXES.md` | The bug tracker (index block first) and the per-fix ledger with commits and rebuild flags. |
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
npm test                            # 2263 unit + integration tests (as of 2026-09-23; two known reds tracked in BUGS.md)
```

Daemon restart without a shell (the daemon relaunches itself through Task Scheduler in about three seconds):

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3747/admin/daemon/restart -ContentType application/json -Body '{"reason":"new dist"}'
```

Live knobs (`runtime_config`, read on every use, no rebuild): `auto_clear_mode` (off, shadow, live: the one switch for every layer's context clear), `lex_self_clear_pct` (Lex's own setpoint, default 70), `l1_clear_pct` (the voice's setpoint, default 50), `top_model` (Layer 1 model, haiku), `dispatch_confirm_gate` (park Lex's worker dispatches for a spoken yes), `mid_permission_mode`. Set with `POST /runtime-config/<key> {"value": ...}` or the dashboard switches.

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
- [docs/spec/LAYER-1-CONTROL.md](docs/spec/LAYER-1-CONTROL.md)
  The three voice layers: boot order, the Layer 1 contract, the
  per-utterance turn and the `[live]` block, barge v3, single-mouth
  invariants, plan approval and dispatch confirm by voice, context
  hygiene, the spoken test list.
- [docs/spec/SMART-COMPACT.md](docs/spec/SMART-COMPACT.md)
  The context lifecycle: who drives each layer's clear, the handover
  frame, the routes, the self-clear checks, the context pack, the
  restart-verify recipe.

---

## Why this exists

Because Claude forgets between sessions, and you forget between projects. Together you keep solving the same problems in slightly different ways. DevNeural is the persistent layer that makes both of you smarter at your actual work, while keeping every byte on your own machine.

---

## License

See `LICENSE`.

---

*Michael Collins. Stay on the level.*
