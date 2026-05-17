# 07-daemon

The DevNeural v2 daemon. Owns capture, ingest, query, lint, reconcile, the wiki, the in-process vector store, SQLite, and the WebSocket. Local-first by default: no API keys required, no cloud calls.

## What it does

Watches your work in real time. Compiles a wiki of transferable insights from your sessions. Injects the relevant page into Claude every time you submit a prompt. Reinforces pages that prove useful, decays pages that are ignored or contradicted. All local. All private.

See `docs/spec/devneural-v2.md` for the full architecture and `docs/spec/DEVNEURAL.md` for the wiki schema the LLM follows.

## Prerequisites

- Node 20 or newer
- [ollama](https://ollama.com) installed and running (or set `DEVNEURAL_LLM_PROVIDER=anthropic` and an `ANTHROPIC_API_KEY`)
- A pulled model: `ollama pull qwen3:8b` (or `qwen2.5:7b-instruct`)

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

To stop:

```bash
curl -X POST http://127.0.0.1:3747/shutdown    # if you add /shutdown
# or:
taskkill /F /PID <pid>
```

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
    DEVNEURAL.md                           # schema, copied from docs/spec/
    index.md
    log.md
    whats-new.md                           # weekly digest
    pages/                                 # canonical pages
    pending/                               # speculative drafts
    archive/                               # decayed-out pages
    glossary/<project_id>.md
    .git/                                  # auto-versioned
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
        └─ whats-new digest
```

## Tests

```bash
npm test
```

Vitest. 703 unit + integration tests as of 2026-05-16 (two pre-existing timeouts in audit-findings + session-end-pipeline excluded; tracked as separate issues). Covers: secret scrubbing, project ID, vector store persistence and search, SQLite + FTS, wiki schema parse/render/validate, validator (parse + repair + retry budgeting), curation (prompt filter, glossary parse and match), smart compact, supervisor, brainstorm pipelines, voice commands.

LLM calls are not exercised in tests to avoid token cost and ollama dependency.

## License

See repo root.
