# 07-daemon

The DevNeural v2 daemon. Owns capture, ingest, query, lint, reconcile, the wiki, the in-process vector store, SQLite, the WebSocket, the dashboard static serve, and Lex: the voice layers, the supervisor of every Claude Code worker, and the context lifecycle. Local-first by default: no API keys required, no cloud calls. Lex and the voice layers are headless `claude` sessions on the operator's Claude subscription; nothing on that path reads an API key (pinned by `tests/no-anthropic-api.test.ts`).

## What it does

Watches your work in real time. Compiles a wiki of transferable insights from your sessions. Injects the relevant page into Claude every time you submit a prompt. Reinforces pages that prove useful, decays pages that are ignored or contradicted. Hosts Lex: one voice session and one brain session per brainstorm, scoped to one supervised worker, with handovers and context clears on every layer. All local. All private.

See `../docs/spec/FUNCTIONAL-SPEC.md` for the system contract, `../docs/spec/LAYER-1-CONTROL.md` for the voice layers, `../docs/spec/SMART-COMPACT.md` for the context lifecycle, and `../docs/archive/spec/DEVNEURAL.md` for the wiki schema the LLM follows (the live copy is `wiki/DEVNEURAL.md` in the data root).

## Prerequisites

- Node 24 (ESM, `node-pty`)
- [ollama](https://ollama.com) installed and running for the wiki LLM (or set `DEVNEURAL_LLM_PROVIDER=anthropic` and an `ANTHROPIC_API_KEY` for wiki ingest only; the Lex layers never use it)
- A pulled model: `ollama pull qwen3:8b` (or `qwen2.5:7b-instruct`)
- Claude Code CLI (`claude`) signed in to a Claude subscription: Lex, the voice layer and the judge session run as `claude` sessions
- For voice: whisper.cpp (cuBLAS build) and Piper, see `../docs/install/AUDIO-VIDEO.md` and `../docs/HOW-TO-voice-and-push.md`

## Setup (first run)

```bash
cd C:/dev/Projects/DevNeural/07-daemon
npm install
npm run setup
```

`setup` is idempotent. Safe to re-run. It:

1. Creates `c:/dev/data/skill-connections/` and the wiki scaffold
2. Verifies ollama is running and the default model is pulled
3. Installs Claude Code hooks in `~/.claude/settings.json` (with backup at `~/.claude/settings.json.devneural.bak`). Migrates away from any v1 DevNeural hooks.
4. Prints the final status

If ollama is not yet running, `setup` will tell you exactly what to do. Re-run `setup` after starting ollama.

## Daily use

The daemon is **lazy-started** by the first Claude tool call after a reboot. You don't need to run anything.

To check the system at any time:

```bash
npm run status
```

To start the daemon manually (e.g. for development):

```bash
npm run start         # production
npm run dev           # tsx watch mode
```

To restart onto a new `dist/` (the daemon relaunches itself through Task Scheduler in about three seconds; every open brainstorm is reaped and reopens on the next voice attach or `POST /lex/anchors/:id/open`):

```bash
curl -X POST http://127.0.0.1:3747/admin/daemon/restart -H "Content-Type: application/json" -d '{"reason":"new dist"}'
```

To stop for good: `taskkill /F /PID <pid>` (pid from `GET /health`), then disable the `DevNeural-Daemon` scheduled task or it comes back.

## What lives where

```
c:/dev/data/skill-connections/
  daemon.pid
  daemon.log
  projects.json                            # registry: id -> name, path, remote
  index.db                                 # SQLite metadata + FTS5
  projects/<id>/                           # 12-char hash of git remote origin
    project.json
    observations.jsonl                     # every tool call, prompt, stop
    transcripts.jsonl                      # transcript chunks, by reference
    .observer.pid
    .observer-signal-counter
    .last-purge
  global/observations.jsonl                # fallback (no project detected)
  chroma/collections/                      # custom in-process vector store (historical name; not Chroma DB)
    raw_chunks/
    wiki_pages/
  models/                                  # ONNX embedder cache
  session-state/
    <session>.summary.md                   # rolling per-session digest
    <session>.task.md                      # current-task memory
    <session>.meta.json
  reinforcement.log.jsonl                  # all hits, corrections, archives
  corpus-seed.state.json                   # initial-corpus run record
  wiki/                                    # the brain (markdown + git)
    DEVNEURAL.md                           # schema (archived copy in docs/archive/spec/)
    index.md
    log.md
    whats-new.md                           # weekly digest
    pages/                                 # canonical pages
    pending/                               # speculative drafts
    archive/                               # decayed-out pages
    glossary/<project_id>.md
    .git/                                  # auto-versioned
  brainstorm/                              # Layer 2 (Lex brain) cwd, shared by every brainstorm
    HANDOVER-<date>-*.md                   # resume seeds a session leaves for the next
    *.md                                   # design docs Lex and the operator wrote here
  brainstorms/<brainstorm id>/             # per-brainstorm handovers (Phase C)
    HANDOVER-<stamp>.md                    # worker draft + Lex review, or Lex draft + judge review
    HANDOVER-INDEX.md                      # rolled-up older handovers
  voice-l1/                                # Layer 1 (voice) cwd: bare, outside every repo, trust-seeded
  lex-prompts/                             # personality files (guarded read-only by the daemon)
```

## Configuration (env)

| Var | Default | Effect |
|---|---|---|
| `DEVNEURAL_LLM_PROVIDER` | `ollama` | `ollama`, `anthropic`, or `none` |
| `DEVNEURAL_OLLAMA_HOST` | `http://localhost:11434` | Where ollama lives |
| `DEVNEURAL_OLLAMA_MODEL` | `qwen3:8b` | Model used for all LLM roles |
| `DEVNEURAL_DATA_ROOT` | `C:/dev/data/skill-connections` | Override data root |
| `DEVNEURAL_PORT` | `3747` | Daemon HTTP port |
| `DEVNEURAL_HOOK_PROFILE` | `standard` | `minimal` suppresses observation hooks |
| `DEVNEURAL_SKIP_OBSERVE` | _(unset)_ | Set `1` for cooperative skip in automation |
| `DEVNEURAL_OBSERVE_SKIP_PATHS` | `daemon-sessions,.devneural-mem` | Comma-separated cwd patterns to skip |
| `DEVNEURAL_COSINE_FLOOR_WIKI` | `0.55` | Below this, no wiki page is injected |
| `DEVNEURAL_COSINE_FLOOR_RAW` | `0.65` | Below this, no raw chunk fallback |
| `DEVNEURAL_INJECT_TOKEN_BUDGET` | `600` | Hard cap on injection size |
| `DEVNEURAL_HIT_COSINE` | `0.65` | Above this, an injected page counts as a hit |
| `DEVNEURAL_CURATE_TIMEOUT_MS` | `1500` | Max time the prompt hook waits for /curate |
| `DEVNEURAL_CURATOR_LLM` | _(unset)_ | Set `1` to route curator output through the LLM (slower, sharper) |
| `DEVNEURAL_LLM_REPAIR_RETRIES` | `2` | Repair retries on bad LLM output |

Project-level opt-out: drop a `.devneural-ignore` file at any project root. Capture and ingest skip that tree entirely.

Voice and Lex env (all optional): `DEVNEURAL_VOICE_HAIKU` (`0` opts the voice tier out; on by default), `DEVNEURAL_VOICE_BRAIN_SESSION_CWD` (Layer 1 cwd, default `<data root>/voice-l1`), `DEVNEURAL_VOICE_BRAIN_MAX_JSONL_BYTES` (Layer 1 respawn size cap), `DEVNEURAL_JUDGE_SESSION` (`0` disables the judge session), `DEVNEURAL_WORKER_HANDOFF_ENABLED`, `DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED`.

### Runtime config (live, no rebuild)

Keys in the `runtime_config` table, read on every use. Set with `POST /runtime-config/<key> {"value": "..."}` or the dashboard switches.

| Key | Default | Effect |
|---|---|---|
| `auto_clear_mode` | `off` | The one switch for every layer's context clear: `off`, `shadow` (compute and log, never clear), `live`. Writes `smart_clear_mode` and `smart_compact_mode` too. |
| `lex_self_clear_pct` | `70` | Lex's own setpoint; past it the daemon nudges her with `[self-clear-due]` (live mode) |
| `l1_clear_pct` | `50` | The voice's setpoint; past it Layer 1 respawns at the next quiet moment |
| `top_model` | `haiku` | Layer 1 model |
| `top_effort`, `mid_effort`, `worker_effort` | unset | Effort dials (no effect on haiku) |
| `dispatch_confirm_gate` | `off` | `on` parks every Lex worker dispatch until the operator says yes by voice |
| `mid_permission_mode` | `bypassPermissions` | Layer 2 permission mode; `plan` routes ExitPlanMode through Layer 1 |
| `supervision_mode` (per anchor) | `event` | `polling` after the kill-switch trips |

## HTTP endpoints

```
GET  /health                          # phase, pid, store sizes, llm status
GET  /projects                        # registry
GET  /graph                           # wiki nodes + edges (for orb)
GET  /page/:id                        # raw page + frontmatter
GET  /glossary/:project_id            # glossary entries
GET  /session/:sid/summary            # rolling summary
GET  /session/:sid/task               # current-task memory
POST /search                          # vector search either collection
POST /curate                          # injection payload for a prompt
POST /summarize                       # force a session summary update
POST /glossary                        # force a glossary update
POST /task                            # force current-task update
POST /ingest                          # manual ingest of arbitrary content
POST /reseed                          # re-run initial corpus ingest
POST /lint                            # lint pass (apply: false by default)
POST /whats-new                       # regenerate the weekly digest
POST /decay                           # decay all page weights once
POST /sync                            # legacy hook for devneural-projects
POST /admin/daemon/restart            # relaunch onto the current dist

# Lex and the voice layers (the full list with bodies lives in src/lex/system-prompt.ts)
GET  /lex/snapshot                    # live state Lex reads before answering
GET  /lex/anchors[?status=live]       # brainstorm anchors; POST /lex/anchors/:id/open spawns L1 then L2
GET  /lex/anchor-tiles                # deck tiles with worker_ctx_pct / lex_ctx_pct / thresholds
POST /lex/recall                      # source-classed retrieval
POST /lex/inject-cross-session        # Lex -> worker dispatch (scope-locked, HMAC token, confirm gate)
GET  /lex/smart-clear/state           # worker ctx and the wind-down verdict
POST /lex/smart-clear/handover-request  # ask the worker for its handover
POST /lex/smart-clear/review          # Lex's vet of the worker draft; held_for_approval | no_voice
POST /lex/smart-compact/clear-and-paste # clear the worker and paste the handover (by handover_id)
POST /lex/smart-clear/confirm         # trail-confirm the worker resumed
GET  /lex/anchors/:id/handovers[/:file] # browse handovers, newest first
GET|POST /lex/auto-clear/mode         # the one switch
GET  /lex/self-clear/state            # Lex's own ctx and setpoint
POST /lex/self-clear                  # Lex's handover in; vet + fact check + judge; then /clear
POST /lex/clear-handoff               # the fresh Lex session's boot block (SessionStart hook)
GET  /lex/context-pack                # the rich pack (worker git, handovers, plan state, summaries, bugs)
POST /worker/clear-handoff            # the fresh worker session's boot block (SessionStart hook)
WS   /lex/voice                       # the voice client (STT in, TTS out, controls)
```

## Troubleshooting

### "ollama unreachable"

Start ollama. On Windows: launch the desktop app, or `ollama serve` from a shell. Then `npm run status`.

### "model qwen3:8b not pulled"

```bash
ollama pull qwen3:8b
```

If you prefer a smaller / different model, set `DEVNEURAL_OLLAMA_MODEL` to whatever you've pulled.

### "v1 hooks present"

Run `npm run install-hooks` (or `npm run setup`). It strips v1 entries and installs v2.

### Daemon won't lazy-start

Check `c:/dev/data/skill-connections/daemon.log`. Common causes: dist/ not built (`npm run build`), node not on PATH, port 3747 in use.

### How do I see what the system is doing?

```bash
npm run status
tail -f c:/dev/data/skill-connections/daemon.log
tail -f c:/dev/data/skill-connections/projects/*/observations.jsonl
cat c:/dev/data/skill-connections/wiki/whats-new.md
cat c:/dev/data/skill-connections/wiki/lint-report.md
```

### Reset everything

```bash
# Kill the daemon
taskkill /F /PID $(cat c:/dev/data/skill-connections/daemon.pid)
# Remove all state (DESTRUCTIVE)
rm -rf c:/dev/data/skill-connections/
# Re-run setup
npm run setup
```

## Architecture summary

```
Claude Code session
  │
  ├─ PreToolUse / PostToolUse / UserPromptSubmit / Stop hooks
  │     ↓ stdin (JSON)
  │   hook-runner (Node, < 50ms)
  │     ├─ resolve project id (hashed git remote)
  │     ├─ scrub secrets
  │     ├─ append observations.jsonl
  │     ├─ on UserPromptSubmit: POST /curate, write injection to stdout
  │     └─ throttle-signal daemon (every N events)
  │
  └─ Daemon (long-running)
        ├─ chokidar transcript watcher → embed → raw_chunks + transcripts.jsonl
        ├─ chokidar fs watcher → observations
        ├─ git watcher (poll) → observations
        ├─ ingest pipeline (Pass 1 filter + Pass 2 write, validated)
        ├─ corpus seed (skills + projects + sessions + commits)
        ├─ session summarizer + glossary builder + current-task memory
        ├─ context curator (deterministic + optional LLM polish)
        ├─ reinforcement (hit / correction / decay / promote / archive)
        ├─ lint (sampled, dry-run by default)
        ├─ whats-new digest
        └─ Lex
              ├─ Layer 1 voice: one headless haiku claude per brainstorm (voice-brain-session.ts, voice-top-layer.ts)
              ├─ Layer 2 brain: one opus claude per brainstorm, scoped to one worker (spawn-lex-session.ts, system-prompt.ts)
              ├─ voice WS coordinator: STT, VAD, barge, TTS stream, controls (voice/lex-voice-ws.ts)
              ├─ supervisor: worker events from the transcript (worker-event-*.ts), expectation supervisor, judge session
              └─ context lifecycle: handovers, approval, self-clear, context pack (lex/handover-*.ts, lex/lex-self-clear.ts, lex/lex-context-pack.ts)
```

## Tests

```bash
npm test
```

Vitest. 2263 unit + integration tests across 247 files as of 2026-09-23; two known reds (`grooming-routes`, `sessions-anchor-liveness`) are tracked in `../BUGS.md`. Covers: secret scrubbing, project ID, vector store persistence and search, SQLite + FTS, wiki schema parse/render/validate, validator (parse + repair + retry budgeting), curation, smart compact and smart clear, the supervisor detectors and router, brainstorm pipelines, the voice layers (contract parser, live block, barge, delivery verbs, spawn args), handover frames and routes, self-clear, the context pack, and the no-API pin.

Model calls are not exercised in tests: no ollama, no `claude` spawn (the judge and voice sessions are faked through their deps).

## License

See repo root.
