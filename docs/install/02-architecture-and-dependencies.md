# 02: Architecture and dependencies

> What DevNeural is made of, what each piece does, what each piece depends on, and how they talk.
> Read this before installing so the file lists in `03-files-and-paths.md` make sense.

---

## High-level architecture

```
   ┌──────────────────────────────────────────────┐
   │  Claude Code session(s) (running in editors) │
   └───────────┬─────────────────┬────────────────┘
               │ hook events      │ writes
               │ (Pre/Post/Prompt │ session transcripts
               │  /Stop)          │ to ~/.claude/projects/
               ▼                  ▼
   ┌──────────────────────────────────────────────┐
   │  Hook runner (Node binary, < 50ms per call) │
   │  - resolves project id                       │
   │  - scrubs secrets                            │
   │  - appends observations.jsonl                │
   │  - calls /curate at UserPromptSubmit         │
   │  - lazy-spawns daemon if not running         │
   └───────────┬──────────────────────────────────┘
               │ HTTP localhost:3747
               │ (curate / health / etc)
               ▼
   ┌──────────────────────────────────────────────────────────┐
   │  07-daemon (Node process, long-running)                 │
   │  ┌────────────────────────────────────────────────────┐ │
   │  │ Capture: transcript watcher, fs watcher, git poll  │ │
   │  └────────────────────────────────────────────────────┘ │
   │  ┌────────────────────────────────────────────────────┐ │
   │  │ Brain: ingest, query, lint, reconcile, decay      │ │
   │  └────────────────────────────────────────────────────┘ │
   │  ┌────────────────────────────────────────────────────┐ │
   │  │ Curation: summarizer, glossary, current-task,     │ │
   │  │           context curator                          │ │
   │  └────────────────────────────────────────────────────┘ │
   │  ┌────────────────────────────────────────────────────┐ │
   │  │ Reinforcement: hits/corrections/decay/promotion   │ │
   │  └────────────────────────────────────────────────────┘ │
   │  ┌────────────────────────────────────────────────────┐ │
   │  │ HTTP API + WebSocket (Fastify on :3747)           │ │
   │  └────────────────────────────────────────────────────┘ │
   └─────┬───────────────┬────────────────┬──────────────────┘
         │               │                │
   POST /api/chat   read/write       read/write
         │               │                │
         ▼               ▼                ▼
   ┌──────────┐  ┌──────────────┐  ┌──────────────────┐
   │ ollama   │  │ Vector store │  │ wiki/ + ref/ on  │
   │ :11434   │  │ (custom,     │  │ disk + SQLite    │
   │ qwen3:8b │  │  in-process) │  │ (index.db)       │
   └──────────┘  │ raw_chunks   │  └──────────────────┘
                 │ wiki_pages   │
                 │ reference    │
                 └──────────────┘

> The "Vector store" is a custom in-process linear-scan implementation
> in `07-daemon/src/store/vector-store.ts`. It is NOT Chroma DB; the
> on-disk directory is still named `chroma/` for historical reasons
> only (a rename is a separate refactor with migration cost).
```

**Phase 3 adds (above):**

```
   ┌──────────────────────────────────────────────┐
   │  08-dashboard (Next.js, served by daemon)    │
   │  - PIN auth                                   │
   │  - Stream Deck of sessions                    │
   │  - Wiki/reference search + upload             │
   │  - System metrics + service status            │
   │  - Daily brief, reminders, notifications      │
   │  - Orb panel placeholder (Phase 4)            │
   └───────────┬──────────────────────────────────┘
               │ HTTP / WS over Tailscale
               ▼
       Browser on phone or desk

   ┌──────────────────────────────────────────────┐
   │  09-bridge (small VS Code extension on host) │
   │  - receives prompt-injection messages from   │
   │    daemon, pastes into terminal              │
   │  - executes window-focus actions             │
   └──────────────────────────────────────────────┘
```

---

## Modules in the repo

| Path | Role | Phase |
|---|---|---|
| `07-daemon/` | The brain. Capture, ingest, query, lint, reinforcement, HTTP/WS API, in-process vector store + SQLite, embedder, ollama client | Phase 1 (built) |
| `03-web-app/` | The orb (Three.js visualization). Currently bound to v1; rebinds to wiki data model | Phase 4 |
| `05-voice-interface/` | Voice query layer | reshapes later |
| `06-notebooklm-integration/` | Obsidian / NotebookLM sync | reshapes later |
| `08-dashboard/` | Central control dashboard, Next.js + PWA | Phase 3 |
| `09-bridge/` | VS Code extension for session bridge + window focus | Phase 3 |
| `archive/v1/` | v1 modules (01-data-layer, 02-api-server, 04-session-intelligence) once burndown completes | Phase 2 |

External (separate repo):

| Repo | Role |
|---|---|
| `Omnib0mb3r/dev-template` | The starter template cloned for new projects |
| `Omnib0mb3r/Claude-Setup` | Backup / canonical record of the user's `~/.claude/settings.json`, global `CLAUDE.md`, hook scripts |
| `Omnib0mb3r/devneural-projects` (may be archived in burndown) | Legacy monday.com sync, currently being deprecated |

---

## Runtime dependencies

### NPM packages used by the daemon

(See `07-daemon/package.json` for canonical list. This is the conceptual breakdown.)

| Package | Used for |
|---|---|
| `fastify` + `@fastify/websocket` | HTTP and WS surface |
| `chokidar` | File watching (transcript, fs, wiki) |
| `@xenova/transformers` | Local ONNX embedder (MiniLM) |
| `better-sqlite3` | Synchronous SQLite for metadata + FTS5 |
| `@anthropic-ai/sdk` | Optional fallback provider when `DEVNEURAL_LLM_PROVIDER=anthropic` |
| `tsx` (dev only) | Watch mode |
| `vitest` (dev only) | Tests |

### NPM packages added in Phase 3

| Package | Used for |
|---|---|
| `next` | Dashboard frontend |
| `react`, `react-dom` | Same |
| `tailwindcss` | Styling |
| `@radix-ui/*`, `lucide-react`, `class-variance-authority`, `tailwind-merge`, `clsx` | shadcn/ui dependencies |
| `tremor`, `recharts` | Charts |
| `@tanstack/react-query` | Client state |
| `pdf-parse` | PDF text extraction |
| `tesseract.js` | OCR for images and scanned PDFs |
| `whisper-node` (or similar wrapper) | Local audio transcription via whisper.cpp |
| `ffmpeg-static` | Audio extraction from video |
| `mammoth` | DOCX parsing |
| `web-push` | PWA push notifications |
| `@fastify/multipart` | File upload handling |
| `bcryptjs` | PIN hashing |

### External binaries

| Binary | Used for | Auto-installed by DevNeural? |
|---|---|---|
| `node` | Runs everything | No (prereq) |
| `npm` | Installs packages | No (prereq) |
| `git` | Clones template, versions wiki | No (prereq) |
| `ollama` | Local LLM | No (prereq); model is pulled by setup |
| `code` | Open VS Code from new-project flow | No (prereq) |
| `claude` | Claude Code CLI | No (prereq) |
| `tailscale` | Remote access for dashboard | No (prereq, Phase 3+) |
| `ffmpeg` | Bundled via `ffmpeg-static` npm | Yes |
| `tesseract` | Bundled via `tesseract.js` (WASM) | Yes |
| `whisper.cpp` | Bundled via wrapper or downloaded by setup | Yes (Phase 3.5) |

---

## Network ports

| Port | Bound by | Bind interface | Notes |
|---|---|---|---|
| `3747` | 07-daemon HTTP + WS | `127.0.0.1` (Phase 1) → `0.0.0.0` (Phase 3, behind Tailscale) | DevNeural API |
| `7474` | 08-dashboard (planned) | served by daemon at `:3747/dashboard` (Phase 3) | Configurable |
| `11434` | ollama | `127.0.0.1` | Default ollama bind |

**No port collisions with common dev tools.** 3747 is unusual on purpose.

---

## Inter-component contracts

| From | To | Via | Purpose |
|---|---|---|---|
| Hook runner | Daemon | HTTP `POST /curate` | Get injection payload at UserPromptSubmit |
| Hook runner | Daemon | `SIGUSR1` (POSIX) / file signal (Windows) | Throttle nudge every N events |
| Hook runner | Daemon | Spawn detached node process | Lazy-start when not running |
| Daemon | ollama | HTTP `POST /api/chat`, `GET /api/tags` | LLM calls |
| Daemon | Wiki on disk | Read/write markdown + git commits | Persist pages |
| Daemon | In-process vector store | Direct function calls | Embedding lookup (custom linear-scan, not Chroma) |
| Daemon | SQLite via better-sqlite3 | Library calls (sync) | Metadata + FTS5 |
| Daemon | Transcript files | chokidar + offset reads | Capture session prose |
| Dashboard (Phase 3) | Daemon | HTTP + WS (over Tailscale) | All operations |
| Daemon | 09-bridge (Phase 3) | File queue at `session-bridge/<id>.in` | Send prompt to running session |
| 09-bridge | VS Code | Extension API | Paste into terminal, focus window |
| 06-NotebookLM (later) | Daemon | HTTP read + filesystem | Sync wiki to Obsidian vault |

---

## Data flow at a glance

**At capture time:**
1. User does anything in Claude Code → hook fires
2. Hook resolves project id (hashed git remote), scrubs secrets, appends to `observations.jsonl`
3. Transcript file updates → daemon's chokidar watcher reads new offset, embeds new chunks, stores in `raw_chunks`
4. fs/git changes → light observations

**At ingest time:**
1. SignalCoalescer or `Stop` hook triggers ingest pass
2. Ingest reads new content + candidate pages (multi-signal selection)
3. Pass 1 (filter) → Pass 2 (write) via local LLM with validation
4. New / updated pages land in `pending/` or get diffs applied
5. Wiki git auto-commits

**At query time (UserPromptSubmit):**
1. Hook calls `POST /curate` with prompt + session + project
2. Daemon embeds prompt → searches wiki_pages + raw_chunks + reference_chunks
3. Curator composes payload (wiki summary + glossary + current-task)
4. Returns markdown blob, hook prints to stdout, Claude Code includes it

**At reinforcement time:**
1. Transcript watcher sees assistant reply → measures cosine vs injected page → hit / miss
2. Sees user follow-up → looks for correction patterns → correction / not
3. Updates page weight, hits, corrections; promotes pending → canonical on first hit; archives on 3+ corrections

---

## Failure modes per component

Knowing where things break helps reconstruction.

| Component | Failure | Symptom | Recovery |
|---|---|---|---|
| ollama not running | Daemon can't ingest | `LLM call failed: fetch failed` in daemon.log | Start ollama, daemon retries |
| Model not pulled | Daemon errors on first ingest | "model not pulled" error | `ollama pull qwen3:8b` |
| Hook can't reach daemon | Injection silent-skipped | No injection appears in Claude responses | Daemon down; restart or wait for lazy-spawn |
| Vector store corruption | Searches return nothing | `/health` shows zero counts | Delete the on-disk `chroma/` dir (historical name only; this is the custom in-process vector store, not Chroma DB); corpus reseed rebuilds |
| SQLite locked | Daemon hangs | `database is locked` error | Kill daemon, remove `index.db-shm` + `-wal`, restart |
| Wiki git conflict | Auto-commit fails | Errors in daemon.log on each ingest | `cd wiki && git status && git stash` |
| Disk full | All writes fail | Multiple errors | Free disk |
| Hook runner not found | No capture happens | Nothing written to observations.jsonl | `npm run build` in 07-daemon |
| Settings.json malformed | Hooks don't fire | Claude Code logs an error | Restore from `~/.claude/settings.json.devneural.bak` |

---

## What runs in the background

Once installed:

- **07-daemon**: long-running. Lazy-started by hook on first tool call after reboot. Lives until killed.
- **ollama**: long-running. Started by you (desktop app or `ollama serve`). DevNeural does not start ollama; that's your responsibility.
- **Hook runner**: short-lived. Spawns and exits per hook event. < 50ms per call.

What does NOT run constantly:

- Ingest passes (run on signal threshold or `Stop` hook)
- Lint (manual or scheduled, see Phase 6)
- Reconcile (weekly)
- Self-query (off by default)
- Dashboard frontend (only when you have a browser tab open)

---

## Why these choices

- **Local LLM (ollama) over API**: zero cost, full privacy, offline-capable.
- **Custom in-process vector store, not Chroma DB**: linear cosine scan in `07-daemon/src/store/vector-store.ts`. One less moving part than a separate Chroma server, simpler ops, fast enough for single-developer volumes. The on-disk directory is still named `chroma/` for historical reasons only.
- **Better-sqlite3 over Postgres/MySQL**: zero install, embedded, fast, sufficient.
- **Single daemon process**: one PID, one log, one port. Simpler to monitor and recover.
- **File-system as the wiki source of truth**: you can read pages with any text editor, version with git, back up with any tool.
- **Hooks instead of intrusive integration**: no Claude Code plugin install required; standard hook protocol.
- **Hashed git remote as project id**: portable across machines, no manual config.

---

Continue to `03-files-and-paths.md` for the complete file inventory.
