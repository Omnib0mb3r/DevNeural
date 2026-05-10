# DevNeural Functional Specification

> **Purpose:** Single source of truth for how every component currently works, what rules govern it, what each layer is responsible for, and where the boundaries are. Read this before changing architecture. Read this before extending Lex. Read this before adding a new layer.
>
> **Last updated:** 2026-05-09
> **Companion docs:** `docs/spec/DEVNEURAL.md` (wiki schema for the ingest LLM), `docs/spec/devneural-v2.md` (legacy architecture, kept for historical context), `docs/HANDOVER-2026-05-09-second-brain-strengthening.md` (in-flight work)

---

## 0. Identity

DevNeural is a personal second brain for software work. It captures everything that happens in Claude Code, builds a semantic search layer (RAG) over the raw record, compiles transferable insights into a maintained wiki, recommends relevant prior thinking to Claude in real time, learns from what actually works, and surfaces it all through a dashboard reachable from anywhere via Tailscale.

Everything runs on local hardware. Default LLM is `qwen3:8b` via ollama. Anthropic API supported as opt-in fallback for ingest quality. Zero cost in default config. Data never leaves the machine except through the user's own off-site backup target.

Six properties define a second brain. DevNeural has all six.

| Property | Wired in DevNeural |
|---|---|
| Persistent memory across sessions, projects, time | wiki + RAG layers stored locally, versioned in git |
| Semantic recall by intent, not keywords | local MiniLM embedder + cosine vector search |
| Watches and learns without being asked | Claude Code hooks + transcript watcher capture continuously |
| Surfaces relevant prior thinking in real time | curator at every UserPromptSubmit injects top relevance |
| Compounds with use | reinforcement loop boosts useful injections, decays unused |
| Lives entirely on local hardware | ollama + ONNX embedder + SQLite + on-disk vec store + on-disk wiki |

---

## 1. Architecture overview

```
Claude Code session(s)
  ├─ hooks (Pre/Post/UserPromptSubmit/Stop/Notification) → hook-runner
  └─ transcripts → ~/.claude/projects/<slug>/<session>.jsonl
                        │
                        ▼
                  ┌─────────────────────────────────────────┐
                  │  07-daemon (long-running, lazy-spawned) │
                  │   capture → embed → ingest → query      │
                  │   reinforce → decay → lint → reconcile  │
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

              ┌──────────────────────────────────────┐
              │  Lex (supervisory voice layer)       │
              │  daemon-PTY hosts a Claude session   │
              │  with the Lex system prompt; voice   │
              │  WS pipes mic + speech in, TTS out   │
              └──────────────────────────────────────┘
```

Every component talks to the daemon over HTTP/WS on `:3747`. The daemon owns SQLite, the vector store, the wiki, the Claude PTYs, the voice loop, and the hook fan-in.

---

## 2. The two-layer principle

DevNeural is built on two complementary retrieval layers. Neither alone is sufficient.

**Semantic layer (meaning-based).** Vector embeddings (MiniLM-L6-v2, 384 dim), cosine similarity, two-tier retrieval. This is what lets recall happen by intent. "The warehouse layout decision" finds work where those words were never used.

**Logical layer (rule-based).** The `[trigger] → [insight]` page schema, validation gates on every LLM output, promotion criteria, reinforcement rules, hard editorial rules from `docs/spec/DEVNEURAL.md`. This is what keeps the wiki from becoming a junk drawer.

Without semantics: a junk drawer of insights nobody can find. Without logic: a vector store of noise that scores high but means nothing. The combination is what makes the wiki a brain.

---

## 3. Capture pipeline

### 3.1 Hook fan-in

Claude Code hooks are registered for: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `Notification`. All four route through `07-daemon/scripts/silent-shim/bin/silent-shim.exe` so they never flash a console window on Windows. The shim wraps the actual hook script (`07-daemon/dist/capture/hooks/hook-runner.js`).

`hook-runner.js` writes one observation per event into `<dataRoot>/projects/<id>/observations.jsonl` and emits a `SIGUSR1` to the running daemon every N events so the auto-ingest signal coalescer can fire near-instant.

### 3.2 Transcript watcher

`07-daemon/src/capture/transcript-watcher.ts` chokidar-watches `~/.claude/projects/<slug>/<session>.jsonl`. Reads incrementally from a persisted byte offset (`<dataRoot>/transcript-offsets.json`). For each new jsonl record:

1. Extract `role`, `text`, `cwd`, `sessionId`, `timestamp`, `uuid`
2. Scrub secrets via `secret-scrub.ts` (regex match against API key shapes, env var prefixes, JWT structures)
3. Append a kind-classified record to `<dataRoot>/projects/<id>/transcripts.jsonl`
4. Mirror as an observation for signal coalescing
5. Drive the dashboard's per-session phase indicator (`thinking` / `tool` / `idle`)
6. Run reinforcement evaluators (assistant reply → cosine-match against pending injection; user message → regex-match for correction patterns)
7. Append into the **turn-bounded chunk buffer** (see 3.3) for vector embedding

### 3.3 Turn-bounded chunking

As of 2026-05-09 (commit `47a8510`), consecutive same-`(session_id, role)` jsonl lines merge into ONE vector chunk. The (session, role) transition flushes the open buffer; end of batch flushes whatever is still open.

Why: a 20-line assistant turn (intro text + tool_use + tool_result + final text) used to become 20 separate vectors in `raw_chunks`. Cosine match on a fragment surfaced the fragment out of context. Now it's one vector representing the full turn, capped at 4000 chars for the embed itself but with `byte_length` metadata reflecting the merged length.

Backstops:
- 8000-char merged-text cap forces a flush mid-turn for runaway monologues
- Across-batch turn split: when the watcher polls mid-turn, the two halves end up adjacent (rare, acceptable)

Per-line side effects (transcripts.jsonl append, observations, reinforcement signals, dashboard phase) STAY per-line. Only the vector chunk emission moved to per-turn.

### 3.4 Secret scrubbing

`07-daemon/src/capture/secret-scrub.ts` runs at the watcher boundary BEFORE anything is persisted. Matches are replaced with `[REDACTED]` placeholders. Patterns include AWS keys, Anthropic keys, GitHub tokens, generic high-entropy strings >= 32 chars, and standard env-var assignment shapes.

Two layers of secret defense, both already wired:
- **Capture-side**: `secret-scrub.ts` for stored chunks. Catches accidental paste, voice transcripts of read-aloud secrets, file content captured in tool_result blocks.
- **LLM-behavior-side**: the user's global `CLAUDE.md` rules say "NEVER run echo $VAR", "NEVER display the full contents of any file that may contain secrets without sanitizing". Catches what Claude says/writes.

Both needed. Neither sufficient alone.

---

## 4. Storage layer

### 4.1 Vector store

`07-daemon/src/store/vector-store.ts`. Replaced Chroma with an in-process linear cosine scan. Storage:

- `<dataRoot>/chroma/collections/<name>/.vec` — packed Float32 vectors, atomic flush
- `<dataRoot>/chroma/collections/<name>/.meta.jsonl` — one JSON line per vector
- `<dataRoot>/chroma/collections/<name>/.head.json` — collection header

Two collections: `raw_chunks` and `wiki_pages`. Both 384-dim (MiniLM-L6-v2 via `@xenova/transformers`).

Search is dot-product on normalized vectors. `search(query, {topK, filter, minScore})` allows metadata filters such as `project_id`, `session_id`. Filtering happens in-memory after the cosine scan.

### 4.2 SQLite

`07-daemon/src/store/index-db.ts`. Single `index.db` file at `<dataRoot>/index.db`. Tables:

| Table | Purpose |
|---|---|
| `raw_chunks_meta` | `id, project_id, session_id, timestamp_ms, kind, role, byte_length` indexed on `(project_id, timestamp_ms DESC)` and `(session_id)` |
| `wiki_pages_meta` | `id, title, trigger, insight, status, weight, hits, corrections, created_ms, last_touched_ms, projects_json, human_edited` |
| `wiki_fts` (FTS5) | full-text search over `page_id, title, trigger, insight, body` |
| `brainstorm_sessions` | `id, claude_session_id, pty_id, cwd, user_label, derived_label, mode, status, started_ms, ended_ms, turn_count, topic_tags_json, artifacts_json, last_summary, last_summary_ms` |
| `pending_prompt_meta` | dashboard permission/elicitation prompts surfaced from CC's Notification hook |
| `reference_chunks_meta` | uploaded PDFs/manuals/audio/video corpus metadata |

### 4.3 Wiki on disk

`<dataRoot>/wiki/`:
- `pages/` — canonical, promoted pages
- `pending/` — drafts awaiting reinforcement promotion
- `archive/` — decayed-out or explicitly-archived
- `glossary/` — term definitions (separate schema)
- `index.md` — title + id + weight catalog rebuilt every ingest
- `log.md` — append-only audit trail of every ingest/lint/reconcile
- `whats-new.md` — daily-brief input
- `lint-report.md` — last lint pass output
- `DEVNEURAL.md` — schema spec (canonical copy in `docs/spec/`)

Every page is a markdown file with YAML frontmatter (id, title, trigger, insight, summary, status, weight, hits, corrections, created, last_touched, projects, human_edited). Sections: `# Title`, `## Pattern`, `## Cross-references`, `## Evidence`, `## Open questions`, `## Log`. Spec at `docs/spec/DEVNEURAL.md`.

---

## 5. Wiki ingest operation

### 5.1 Trigger paths

Two triggers:

1. **Real-time signal** (near-instant): `hook-runner` sends SIGUSR1 every N captured events. Daemon's signal coalescer fires `runAutoIngest()` once per debounced window.
2. **Periodic interval** (5 min default): `daemon.ts:587` calls `startAutoIngestInterval()`. Tunable via `DEVNEURAL_AUTO_INGEST_INTERVAL_MS`.

Plus a third **session-end** path added 2026-05-09 (commit `e0b1582`): `forceIngestProject(projectId)` runs at every voice/PTY end path and bypasses the 600-byte minimum. See section 11.

### 5.2 Two-pass LLM

`07-daemon/src/wiki/ingest.ts`:

**Pass 1 — Filter.** Send the new content + candidate page metadata (selected by the four-signal union: embedding similarity, cross-ref hops, entity overlap, FTS) to the LLM. LLM returns:
```json
{
  "affected_pages": ["page-id-1", "page-id-2"],
  "new_page_warranted": true,
  "new_page_reason": "this content describes a recurring pattern not covered by any candidate"
}
```
Up to 5 affected pages. Pass-1 input ≤8K tokens, output ≤500 tokens.

**Pass 2 — Write.** LLM receives the full body of each affected page plus the new content, returns:
- `page_updates`: array of `{id, evidence_add?, log_add?, cross_refs_add?, cross_refs_remove?, pattern_rewrite?, summary_rewrite?, flag_for_review?}`
- `new_pending_page`: optional `{id, title, trigger, insight, summary, pattern_body, evidence, cross_refs}` or `null`

Pass-2 input ≤8K tokens, output ≤2K tokens.

### 5.3 Validation + Anthropic fallback

`07-daemon/src/llm/validator.ts` checks the Pass-2 JSON against the schema. On failure, retries up to `MAX_REPAIR_RETRIES` (default 2). On exhaustion, sets `skipped_reason` and the turn produces no page.

**Pass 2 fallback** (commit `41a68f8`): when `DEVNEURAL_PASS2_FALLBACK=anthropic` and `ANTHROPIC_API_KEY` is set, exhaustion triggers ONE retry against Anthropic Haiku. Off by default. Cost ballpark ~$0.10/day at borderline local-LLM hardware.

### 5.4 Cross-project verifier

When an existing page first gains evidence from a NEW project (`fm.projects.length` goes 1 → 2), a cheap LLM verification call asks "given the existing trigger+insight+pattern, does this new evidence describe the SAME recurring pattern, or just share vocabulary?" Strict JSON `{"same_pattern": boolean}`. Failing closed sets `flag_for_review: true` so unrelated patterns don't silently fuse. Commit `d9e80da`.

### 5.5 Brainstorm-source weight bump

When `writeNewPendingPage()` detects the source project's cwd matches `isBrainstormCwd()`, the new page starts at **weight 0.40** instead of the 0.30 default. Brainstorm output is more curated than ambient coding-session noise; the bump means one fewer reinforcement hit before promotion-relevant retrieval. Commit `bba1cdd`.

### 5.6 Side effects after a successful ingest

1. Page written to `wiki/pending/` or `wiki/canonical/`
2. Embedded into `wiki_pages` collection (title + summary + pattern slice)
3. Upserted into `wiki_pages_meta` SQLite
4. `commitWiki("ingest <source>")` git-commits the wiki dir
5. `scheduleLint()` debounced trigger (60s) so the next lint cycle picks up the new page
6. `appendLog()` writes a one-line audit to `wiki/log.md`

### 5.7 Hard rules from DEVNEURAL.md

The ingest LLM is bound by `docs/spec/DEVNEURAL.md`:

- Pages are transferable insights, not records of events. Title format `[trigger] → [insight]`, mandatory `→` separator.
- Pages are produced exclusively by ingest. Hand-authored pages don't exist.
- New pages must cite at least one session id, commit hash, or file path as evidence.
- `human_edited: true` pages are never rewritten by the LLM. Only evidence/log/cross-ref additions and shape fixes allowed.
- A pattern observed only in one project is a single-project page. Cross-project promotion requires evidence from at least one other project AND the verifier (5.4) must approve.
- No speculation, no truisms, no decorative emoji, no em dashes, no AI co-author tags, no client-confidential content.

---

## 6. Lint operation

`07-daemon/src/wiki/lint.ts` is **maintenance**, not creation. Operates on existing pages:
- All `pending/` pages
- All `canonical/` pages with `weight < 0.2`
- 50 random `canonical/` pages
- All pages flagged for review (`flag_for_review: true`)

For each, decides one of:
| Decision | Trigger |
|---|---|
| Keep | Healthy, no action |
| Auto-fix shape | Summary > 80 tokens, broken cross-ref, missing required frontmatter |
| Archive (pending stale) | `pending/` >= 30 days old with no hits |
| Archive (canonical stale) | `weight < 0.15` AND `last_touched > 90 days` |
| Merge proposal | Cosine > 0.85 + overlapping evidence (held for explicit `--apply`) |
| Split proposal | Body > 800 tokens or > 8 cross-refs (held for `--apply`) |
| Flag contradiction | Two pages assert claims that can't both be true |

`07-daemon/src/wiki/lint-queue.ts` debounces lint triggers so a burst of ingests collapses into one lint cycle 60s later. Single-flight: only one lint runs at a time.

Lint NEVER auto-applies destructive changes to `human_edited: true` pages. Only allowed actions on those: archive (if user explicitly retired), shape-fix non-destructively, append to `## Log`.

---

## 7. Reinforcement and decay

### 7.1 Reinforcement loop

`07-daemon/src/reinforcement/index.ts`:

- **Hit:** Curator injects a wiki page at UserPromptSubmit. Transcript watcher's next assistant reply gets cosine-matched against the page's summary. If cosine >= 0.65, `hits += 1` and `weight += (1 - weight) * 0.05`. Pending pages with a hit are promoted to canonical immediately.
- **Correction:** User's next message is regex-matched against `\bno\b`, `\bactually\b`, `\bwrong\b`, `\bnot what i\b`, etc. On match, `corrections += 1` and `weight -= weight * 0.10`. Page is blacklisted from re-injection in this session. Pages with `corrections >= 3` AND `weight < 0.15` move to archive.
- **Raw-hit:** When a raw_chunk (not a wiki page) was the curator's pick and the assistant reply matches it, the chunk is queued for a wiki ingest pass so the pattern can crystallize into a page.

### 7.2 Decay scheduler

`decayInactivePages()` exists in `reinforcement/index.ts`. Multiplies every page's weight by 0.995 per call. Archives anything dropping below 0.15.

**Scheduler wired 2026-05-09** (commit `9606e30`): runs every 24h by default. Tunable via `DEVNEURAL_DECAY_INTERVAL_MS`. Set to 0 to disable on dev boxes. The audit found that decay was never running automatically before this fix, leaving uninjected pages stuck at full weight forever.

`POST /decay` triggers a one-shot manual run.

### 7.3 What's measured

| Signal | Source | Effect |
|---|---|---|
| Hit | Cosine match between injected summary and assistant reply | weight +up, hits++, promote pending → canonical |
| Correction | Regex on user message after injection | weight -down, corrections++, blacklist for session |
| Decay | Daily timer | weight * 0.995 (universal) |
| Cross-project | New `projects` entry on existing page | trigger verifier (5.4); if approved, evidence accepted |

---

## 8. Retrieval and source-class taxonomy

### 8.1 Two consumers

- `/search/all` — dashboard global search. UI-driven.
- `/lex/recall` — Lex's targeted retrieval. Returns hits grouped by brainstorm session when applicable.

Both go through `07-daemon/src/dashboard/search-all.ts`.

### 8.2 Source-class taxonomy

Every hit gets classified:

| Class | Multiplier | What |
|---|---|---|
| `wiki-canonical` | 1.0 | promoted wiki pages |
| `wiki-pending` | 0.85 | pending wiki drafts |
| `brainstorm` | 0.7 | raw_chunks whose `session_id` matches a `brainstorm_sessions` row |
| `raw` | 0.6 | generic transcript chunks |
| `reference` | 0.5 | uploaded PDFs/manuals |

Final score = `cosine * SOURCE_CLASS_MULTIPLIER[source_class]`. The multiplier is reversible: delete it and you're back to raw cosine. Implemented at `dashboard/search-all.ts:40-46`.

The brainstorm tier is a **search-time** join: the classifier looks up `metadata.session_id` against the `brainstorm_sessions` table on every query. If the row exists, tier-up. If the row was archived, the chunk falls back to `raw` tier; the chunk's metadata `brainstorm_id` and `brainstorm_mode` (added by the session-end pipeline, see 11) survive forever for filtered queries like "show meeting recordings only".

### 8.3 Group-by-session option

`/lex/recall?group_by_session=true` buckets brainstorm chunks under their session card so Lex sees one entry per brainstorm instead of N orphan transcript rows.

---

## 9. Curator (real-time injection)

`07-daemon/src/curation/curator.ts`. Runs at every UserPromptSubmit hook. Steps:

1. Embed the user's prompt
2. Search `wiki_pages` for top-K hits (canonical first, pending second)
3. Search `raw_chunks` for top-K fallback hits (only if no wiki hit clears threshold)
4. Apply source-class multiplier
5. Apply session blacklist (pages corrected in this session can't re-inject)
6. Apply pending-injection-window (one injection per N seconds per session)
7. If best-hit score < threshold: silence (better nothing than noise)
8. Otherwise: inject the page's `summary` block (~150 tokens) as additional context to Claude

The injection is recorded in a `pending` map keyed by session id, expires after 10 minutes, and feeds the reinforcement loop (7.1).

---

## 10. Lex (supervisory voice layer)

### 10.1 Identity

Lex is the always-available coworker that lives on top of every active worker session. Implemented as a daemon-owned PTY hosting a `claude` CLI process with a custom system prompt that defines Lex's voice, modes, and tool contracts.

### 10.2 Modes

| Mode | What | Rule |
|---|---|---|
| `conversation` | Default. Full duplex voice. Spoken responses out loud. | Lex replies briefly, conversationally, no markdown lists |
| `notes` | Dictation. Lex listens and captures everything to artifacts. | Silent reply (no TTS), auto-emits a `notes-summary` artifact on stop |
| `push-to-talk` | No VAD. Hold the talk button, release to send. | For noisy rooms; Lex still replies out loud |

Voice mode is set on `hello` and changeable mid-session via `set-mode`.

### 10.3 Voice loop

`07-daemon/src/voice/lex-voice-ws.ts`. WebSocket protocol:

| Direction | Message | Purpose |
|---|---|---|
| client → server | `{t:"hello", session_id?, mode}` | Bind to PTY |
| client → server | `{t:"utterance-start"}` | Start mic stream |
| client → server | binary PCM frames | 16k mono int16 mic audio |
| client → server | `{t:"utterance-end"}` | Trigger transcribe + inject |
| client → server | `{t:"barge-in"}` | Cancel in-flight TTS |
| client → server | `{t:"set-mode", mode}` | Switch mode mid-session |
| client → server | `{t:"finalize-notes"}` | Notes-mode stop emits a summary artifact |
| server → client | `{t:"hello-ack", voice_rate}` | Confirm bind |
| server → client | `{t:"transcript", text, ms}` | Whisper output |
| server → client | `{t:"injected"}` | Text reached PTY stdin |
| server → client | `{t:"assistant-text", text}` | Final response from Lex |
| server → client | `{t:"tts-start", rate}` | Start TTS audio stream |
| server → client | `{t:"tts-end"}` | TTS done |
| server → client | binary PCM frames | 22050Hz mono int16 TTS audio |
| server → client | `{t:"session-end", reason}` | Spoken end-session command matched; client should setEnabled(false) |
| server → client | `{t:"finalize-injected"}` | Notes-mode finalize prompt landed |

STT: whisper.cpp `whisper-server.exe` (cuBLAS) at `WHISPER_BIN`. Configurable via `DEVNEURAL_WHISPER_BIN`.
TTS: Piper with picker. Voice models in `<dataRoot>/voice/`. Speed adjustable via `/voice/set-speed`.
VAD: silero-vad in the browser via `@ricky0123/vad-web`. Sensitivity tunable. Mute auto-finalizes via parallel ScriptProcessor capture.

### 10.4 End-session command

`END_SESSION_RE` in `voice/lex-voice-ws.ts:96-110`: regex matches "end session", "stop voice", "stop listening", "goodbye Lex", "bye Lex", and natural variants. When a transcript matches, the server skips the inject path (so Lex doesn't generate a normal text reply the user would have to interrupt), sends `{t:"session-end"}` to the client, and fires the session-end pipeline (see 11). Client teardown: `setEnabled(false)` triggers the existing effect that closes WS, mic, audio context, and clears the `lex-voice-enabled` localStorage flag.

### 10.5 Artifacts

`07-daemon/src/lex/artifact-parser.ts`. Lex's assistant turns can include fenced JSON blocks the parser extracts and persists:

| Kind | Category | Effect |
|---|---|---|
| ` ```artifact:research-note` | `research_notes` | JSON file at `<dataRoot>/lex/artifacts/research-note/<id>.json` |
| ` ```artifact:wiki-draft` | `wiki_drafts` | JSON file; future ingest pulls the draft into a real wiki page |
| ` ```artifact:project-intent` | `spawned_projects` | JSON file; dashboard "new project" flow can pick these up |
| ` ```artifact:notes-summary` | `research_notes` (+ reminders fan-out) | Each `reminders_to_create[]` item creates a real reminder via the reminders system |

Each artifact is referenced from the brainstorm row's `artifacts_json` manifest so retrieval can list "all artifacts from session X".

### 10.6 Lex system prompt (current)

`07-daemon/src/lex/system-prompt.ts`. Multi-block prompt assembled at PTY spawn:

1. **Identity block.** "You are Lex, a supervisory voice coworker..." Personality rules.
2. **Mode contracts.** Four blocks defining conversation/notes/push-to-talk/finalize behavior.
3. **Voice contract.** Output rules (terse, no markdown lists, etc).
4. **Synthesis directive.** When/how to emit artifacts.
5. **Tool contracts.** What `/lex/recall`, `/lex/steer`, `/lex/capture`, `/lex/snapshot` do.
6. **Layer 6 snapshot.** Live state (active projects, recent sessions, current foci) computed at spawn time.

The Layer-6 snapshot is **stale by spawn time** and the harness's "Working directories" block above it can override it. Workaround: voice WS prepends a fresh `buildVoiceSnapshot()` to every voice turn user message (see `lex-voice-ws.ts` voice tag injection).

This is the layer that phase two will rebuild as a **live, daemon-watched, dynamic awareness layer**. See section 17.

---

## 11. Brainstorm sessions and session-end pipeline

### 11.1 Brainstorm row lifecycle

`07-daemon/src/lex/brainstorm-store.ts`. Every PTY spawn whose cwd matches `isBrainstormCwd()` (under `<dataRoot>/brainstorm/`) gets a row in `brainstorm_sessions`:

- **Created** at PTY spawn with `status='active'`, `claude_session_id=null`
- **Bound** when the jsonl is discovered (file appears at `~/.claude/projects/<slug>/<session>.jsonl`); `claude_session_id` is patched in
- **Updated** as artifacts are extracted (manifest grows)
- **Ended** at PTY exit OR voice end-session command OR daemon-detected eviction; sets `status='ended'`, `ended_ms=now`, optionally `last_summary`
- **Reaped** at boot: any row stuck at `active` from a prior daemon crash gets force-ended via `reapAllActive()`

### 11.2 Session-end pipeline (commit `e0b1582`)

`07-daemon/src/lex/session-end-pipeline.ts`. One function called from every end path:
- voice "end session" voice command match
- voice WebSocket close
- PTY exit handler
- (notes-mode finalize stays on the existing artifact-parser path)

Steps (each best-effort, failures logged not thrown so teardown never blocks):

1. **`forceIngestProject(projectId)`** — flush the project's `transcripts.jsonl` tail past its last-ingest cursor through `runIngest()`. Same Pass-1 + Pass-2 LLM, same wiki page output, same vector embedding. The 600-byte minimum is bypassed; the LLM's own filter still decides whether anything is worth a page.
2. **`updateSummary(input)`** — refresh the rolling session summary at `<dataRoot>/session-state/<sid>.summary.md`. Inputs are session-scoped (recent chunks for THIS session_id only) so the summary describes this brainstorm, not the whole project.
3. **Embed the summary into `raw_chunks`** with metadata:
   - `kind: 'brainstorm-summary'`
   - `brainstorm_id: <row id>`
   - `brainstorm_mode: 'conversation' | 'notes' | 'push-to-talk'`
   - `end_reason: 'voice-command' | 'pty-exit' | 'ws-close'`
4. `scheduleLint()` runs as a side effect of `runIngest()`; no extra call needed.

The mode tag is the durable marker that this chunk came from a meeting recording (`mode='notes'`) even after the brainstorm row is later archived. Source-class lookup at search time gives it the brainstorm tier (×0.7) while the row is alive; once archived, the chunk falls back to `raw` (×0.6) but the mode metadata persists.

### 11.3 Idempotency

`lex-voice-ws.ts` guards against double-fire across the WS-close + voice-command paths via a `sessionEndFired` flag on connection state. `pty-host.ts` fires the pipeline BEFORE `endBrainstorm()` so retrieval still sees `active` while the chunk is being written.

---

## 12. Dashboard and orb

### 12.1 Dashboard

`08-dashboard/`. Next.js 15 + Tailwind v4 + Tanstack Query. PIN auth on first launch. Statically exported to `out/`; the daemon serves the build at `:3747`. PWA-installable on phones.

Major surfaces:
- `/sessions` — live + recent CC sessions, terminal mirror, prompt injection (via 09-bridge or daemon-PTY), Stream Deck rail, pending-prompt resolver
- `/projects` — registered projects, last-seen, jump to a session
- `/search` — global search across wiki, raw chunks, references, with collection grouping and per-session bundling for brainstorms
- `/wiki` — per-page modal (Pattern, Evidence, Cross-refs, Log) with related-transcripts vector search inline
- `/orb` — force-directed graph of canonical + pending wiki pages, edges from cross-references, weight-driven coloring
- `/lex` — brainstorm tab with voice panel, session list, settings (mute, mode, voice, speed, barge cooldown, VAD sensitivity, mic gain)
- `/settings` — voice tuning, PIN change, system metrics, Tremor sparklines
- `/admin` — daemon restart, decay trigger, lint trigger, backup runner

### 12.2 KPI strip (dashboard home)

`08-dashboard/components/KpiStrip.tsx` renders at the top of the home page. Five rows, one per axis of "is the brain working":

| Row | Tiles | Source |
|---|---|---|
| Size | lines of code, wiki pages (canonical/pending/archived breakdown), raw chunks, reference chunks | `/stats/loc` + `/stats/kpi` |
| Quality | wiki avg weight, hits last 7d (with corrections sub), flagged for review, cross-project pages | `/stats/kpi` (reinforcement.log.jsonl tail + wiki frontmatter scan) |
| Activity | active CC sessions (phase breakdown), active brainstorms (mode breakdown), artifacts captured | `/stats/kpi` (sessions table + brainstorm_sessions + lex/artifacts dir scan) |
| Velocity | commits last 7d across every registered project | `/stats/kpi` (`git log --since=7d` per project) |
| Health | last backup (days/hours ago), daemon uptime, embedder calls | `/stats/kpi` (backup target marker + process.uptime + embedderStats) |

Two endpoints back the strip. `/stats/loc` walks `git ls-files` per project and counts newlines (cached 5 min, polled 60s). `/stats/kpi` is an omnibus snapshot (heavy parts cached 60s, polled 30s). Each sub-computation in `/stats/kpi` is best-effort: a failure returns `null` for that section so a single broken data source does not black out the whole strip.

KpiCard renders one tile: icon, monospace tabular-nums big number, sub line. Animated count-up tween on numeric changes, pulse highlight on growth-signal tiles (LOC, wiki pages, hits, active sessions, commits).

### 12.3 Orb (graph viz)

`07-daemon/src/dashboard/graph.ts`. Reads every page in `wiki/pages`, `wiki/pending`, `wiki/archive`. Nodes from frontmatter, edges from `## Cross-references`. Output: `{nodes: [{id, title, status, weight, ...}], edges: [{source, target, weight}]}`.

The orb (frontend) renders this as a force-directed layout with:
- Node color by status (canonical / pending / archive)
- Node size by weight
- Edge width by average endpoint weight
- Connected-subgraph framing (drag a cluster, the rest follow)
- Animated promoted ring on canonical
- Curved bezier edges with screen-stable widths

**Brainstorm sessions are NOT orb nodes today.** Wiki-only by design. Phase two could add brainstorm rows as a node class with edges to the wiki pages they spawned. Not wired today.

---

## 13. Hooks system

### 13.1 Registered hooks

| Hook | Phase | Action |
|---|---|---|
| PreToolUse | Before each tool call | Capture observation; classify tool |
| PostToolUse | After each tool call | Capture output (scrubbed); update session phase |
| UserPromptSubmit | When user hits Enter | **Inject curator-selected wiki page** as additional context |
| Stop | When assistant turn ends | Capture final text; finalize observation; trigger SIGUSR1 if N events accumulated |
| Notification | CC permission/elicitation prompts | Surface in dashboard `/sessions` for remote answer |

### 13.2 Silent shim

`07-daemon/scripts/silent-shim/bin/silent-shim.exe`. Native Windows binary (Go) that launches a hook script via `bash.exe` with `windowsHide` so no console flashes on screen. All five hooks route through it. Critical for not breaking the user's flow with hundreds of console-flash hooks per minute during heavy CC use.

`silence-all-hooks.ps1` re-wraps every existing hook in `settings.json` with the shim. Idempotent. `repair-double-wrapped-hooks.ps1` peels stacked layers from older runs.

---

## 14. Backup pipeline

`07-daemon/scripts/backup.ps1`, `restore.ps1`, `verify-backup.ps1`, `install-backup-task.ps1`. SQLite atomic capture via `VACUUM INTO`. Manifest with file checksums. Integrity verification (`PRAGMA integrity_check` + JSON parse).

Default schedule: daily 03:00, retain 14, target `<dataRoot>/../devneural-backups`. Recommended target: OneDrive-synced directory or NAS share for off-site durability. `npm run backup-where` shows current target + schedule + last run.

Wiki has its own off-site git push (`startWikiPushInterval` at `daemon.ts:600`), every 5 min by default, skipped silently when no remote configured.

---

## 15. Security model

### 15.1 Threat model

DevNeural is a **personal** second brain on a **personal** machine accessed over **Tailscale** (private mesh, WireGuard-encrypted by default). Threats considered:
- Local disk loss → daily backup pipeline + weekly off-site rotation
- Accidental secret capture in transcripts → `secret-scrub.ts` regex defense at watcher boundary
- Browser session hijack → PIN auth on dashboard, Tailscale ACLs limit who can reach `:3747` at all
- LLM exfiltration of secrets via assistant output → user's global `CLAUDE.md` rules, plus `secret-scrub` on captured assistant output before storage

Threats NOT in scope (by design, single-user personal install):
- Multi-tenant access control, OAuth, JWT — overkill for a personal Tailnet
- HTTPS cert validation beyond what Tailscale Serve provides — Tailscale traffic is encrypted regardless of HTTP/HTTPS layer
- Malicious-actor models on the local network — assumed not present on a personal Tailnet

### 15.2 Defense layers

| Layer | What | Where |
|---|---|---|
| Capture-side scrub | Regex match against API-key shapes, env var assignments, JWTs | `07-daemon/src/capture/secret-scrub.ts` |
| LLM-behavior scrub | User's `~/.claude/CLAUDE.md` global rules forbid printing secrets | User-managed |
| Dashboard auth | PIN auth on first launch; cookie-bound session | `07-daemon/src/dashboard/auth.ts` |
| Network | Tailscale WireGuard encrypted transport | OS-level |
| Backup | Atomic SQLite capture; manifest checksums; OneDrive at-rest encryption | `scripts/backup.ps1` + cloud provider |
| Wiki content | DEVNEURAL.md rule 7.6 forbids LLM from writing secrets/confidential client work | LLM system prompt |

---

## 16. Environment variables

Daemon reads at start. All optional.

| Var | Default | Effect |
|---|---|---|
| `DEVNEURAL_DATA_ROOT` | `C:/dev/data/skill-connections` | Where wiki, vector store, SQLite, session-state live |
| `DEVNEURAL_PORT` | `3747` | Daemon HTTP/WS bind port |
| `DEVNEURAL_LLM_PROVIDER` | `ollama` | `ollama`, `anthropic`, or `none` |
| `DEVNEURAL_AUTO_INGEST_INTERVAL_MS` | `300000` (5 min) | Periodic wiki auto-ingest cadence |
| `DEVNEURAL_AUTO_INGEST_MIN` | `600` | Minimum bytes of new transcript before periodic ingest fires |
| `DEVNEURAL_AUTO_INGEST_MAX` | `8000` | Per-call content cap |
| `DEVNEURAL_DECAY_INTERVAL_MS` | `86400000` (24h) | Reinforcement decay cadence; 0 to disable |
| `DEVNEURAL_PASS2_FALLBACK` | unset | `anthropic` to enable Anthropic Haiku retry on Pass 2 exhaustion |
| `DEVNEURAL_WIKI_PUSH_INTERVAL_MS` | `300000` (5 min) | Off-site git push cadence |
| `DEVNEURAL_SUMMARY_TURNS` | `8` | Turns between rolling summary refreshes |
| `DEVNEURAL_SUMMARY_MIN_MS` | `300000` (5 min) | Min time between summary refreshes |
| `DEVNEURAL_LLM_REPAIR_RETRIES` | `2` | Validator retry count before exhaustion |
| `DEVNEURAL_WHISPER_BIN` | auto-detect | Path to `whisper-server.exe` (cuBLAS) |
| `ANTHROPIC_API_KEY` | unset | Required when using anthropic provider or Pass 2 fallback |

---

## 17. Phase two roadmap (where we go next)

### 17.1 Lex layered awareness

Today Lex's system prompt has a static Layer-6 snapshot computed at PTY spawn time, supplemented by a fresh `buildVoiceSnapshot()` prepended to every voice turn. This is enough for "what project am I in" but not for "what are all my workers doing right now."

**Proposed layered model:**

| Layer | Refresh rate | Content | Source |
|---|---|---|---|
| L0: Identity | Static (set at spawn) | Voice contract, mode contracts, synthesis directive, hard rules | `lex/system-prompt.ts` |
| L1: Live awareness | 5–15s tick | Active CC sessions across all projects, current phase per session, recent user prompt fragments, active brainstorm sessions, recent artifacts | NEW daemon module `lex/awareness-broadcaster.ts` |
| L2: Session context | Per-turn | This brainstorm's recent turns + topic tags + last summary | Existing voice-tag prepend |
| L3: Targeted recall | On-demand via tool | `/lex/recall` results: wiki pages + brainstorm bundles + raw chunks | Existing |
| L4: External tools | On-demand via tool | Web search, file read, calendar, etc. | NEW tool surface to add |

L1 is the missing piece. The daemon already watches every active session via `transcript-watcher`. Adding a small in-memory aggregator that maintains the latest "what is everyone doing" snapshot, then streaming that to Lex's PTY as a system message every 15s (or on significant change), gives Lex always-current high-level awareness without bloating every voice turn.

Acceptance criteria for phase two L1:
- Lex can answer "what's happening across my work right now" without an explicit recall tool call
- Awareness updates live, not at session boundaries
- Snapshot stays under ~2K tokens (room for L0 + L1 + L2 + voice turn + reply within Claude's context window)
- Update mechanism is push, not pull (so Lex doesn't burn turns asking for status)

### 17.2 Lex system prompt customization

The current system prompt is reasonable but generic. Phase two should:

- Version the prompt and bump on every significant change so we can roll back if Lex regresses
- Add user-tunable personality dials (verbosity, formality, when to push back, when to defer)
- Document what each block of the prompt does and which rule it enforces, so editing is principled not vibe-based
- Add explicit examples per mode showing good vs bad responses (few-shot)
- Add an explicit refusal contract for off-topic / out-of-scope requests so Lex doesn't drift into being a generic assistant

### 17.3 Lex feedback loop

The reinforcement loop in section 7 only operates on wiki pages. Lex's responses don't currently feed any signal that could improve future responses. Phase two could add:

- Per-turn Lex-quality marker (thumbs up/down inline in the voice panel; auto-detect strong negative cues like "no that's wrong" similar to the curator correction signal)
- Aggregate the signal per system-prompt version so we can A/B variants empirically
- Surface "Lex's worst-rated turns this week" in the dashboard so the user can see drift early

### 17.4 UI fine-tuning

Items already known:
- Brainstorm row visibility in `/sessions` and dedicated `/lex` lifecycle UI (start/end/relabel/archive)
- `/wiki` → orb deeplink so clicking a wiki page opens the orb at that node
- Dashboard "now playing" indicator showing live active CC + brainstorm + Lex states
- Mobile-first PWA polish (the dashboard works on phone but has rough edges)

### 17.5 Other follow-ups (open)

- Brainstorm-as-orb-node: add brainstorm sessions as a third node class on the graph with edges to wiki pages they spawned
- Per-turn chunking refinement: voice transcripts may want different chunking than coding sessions (utterance-bounded already for voice, currently captured the same as text)
- Reinforcement feedback for brainstorm-summary chunks: do the same hit/correction tracking on retrieval-injected summaries
- Reference-corpus side: PDF/manual upload pipeline lives in `07-daemon/src/reference/` but isn't fully wired to the curator yet

---

## 18. Component file map

| Concern | Path |
|---|---|
| Daemon entry | `07-daemon/src/daemon.ts` |
| Capture | `07-daemon/src/capture/` |
| Vector store | `07-daemon/src/store/vector-store.ts` |
| SQLite + FTS | `07-daemon/src/store/index-db.ts` |
| Embedder | `07-daemon/src/embedder/` |
| LLM providers | `07-daemon/src/llm/` |
| Wiki ingest | `07-daemon/src/wiki/ingest.ts` |
| Wiki auto-ingest | `07-daemon/src/wiki/auto-ingest.ts` |
| Wiki lint | `07-daemon/src/wiki/lint.ts` |
| Wiki schema | `07-daemon/src/wiki/schema.ts` |
| Reinforcement + decay | `07-daemon/src/reinforcement/index.ts` |
| Curator (injection) | `07-daemon/src/curation/curator.ts` |
| Session summarizer | `07-daemon/src/curation/session-summarizer.ts` |
| Glossary | `07-daemon/src/curation/glossary.ts` |
| Lex system prompt | `07-daemon/src/lex/system-prompt.ts` |
| Brainstorm store | `07-daemon/src/lex/brainstorm-store.ts` |
| Artifact parser | `07-daemon/src/lex/artifact-parser.ts` |
| Snapshot context | `07-daemon/src/lex/snapshot-context.ts` |
| Session-end pipeline | `07-daemon/src/lex/session-end-pipeline.ts` |
| Voice WebSocket | `07-daemon/src/voice/lex-voice-ws.ts` |
| Whisper STT | `07-daemon/src/voice/whisper.ts` |
| Piper TTS | `07-daemon/src/voice/piper.ts` |
| PTY host | `07-daemon/src/dashboard/pty-host.ts` |
| Dashboard routes | `07-daemon/src/dashboard/routes.ts` |
| Search-all (source classes) | `07-daemon/src/dashboard/search-all.ts` |
| Graph (orb) | `07-daemon/src/dashboard/graph.ts` |
| KPI omnibus endpoint | `07-daemon/src/dashboard/routes.ts` (search for `/stats/kpi`) |
| KPI strip component | `08-dashboard/components/KpiStrip.tsx` |
| LOC walk endpoint | `07-daemon/src/dashboard/routes.ts` (search for `/stats/loc`) |
| Reference corpus | `07-daemon/src/reference/` |
| Identity registry | `07-daemon/src/identity/registry.ts` |
| Hooks runner | `07-daemon/src/capture/hooks/hook-runner.ts` |
| Silent shim | `07-daemon/scripts/silent-shim/` |
| Backup scripts | `07-daemon/scripts/backup.ps1` etc |
| Dashboard frontend | `08-dashboard/` |
| VS Code bridge | `09-bridge/` |
| Archived v1 | `archive/v1/` |
| Wiki spec | `docs/spec/DEVNEURAL.md` |
| Architecture spec | `docs/spec/devneural-v2.md` |
| **This document** | `docs/spec/FUNCTIONAL-SPEC.md` |
| Live state | `docs/SESSION-HANDOVER.md` |
| In-flight tracking | `docs/HANDOVER-2026-05-09-second-brain-strengthening.md` |

---

## 19. What governs what

Final reference. If a behavior surprises you, this is the source of truth.

| Rule | Lives in |
|---|---|
| Page shape (frontmatter, sections, title format) | `docs/spec/DEVNEURAL.md` |
| What ingest LLM is allowed to do | `docs/spec/DEVNEURAL.md` sections 3, 7 |
| What lint LLM is allowed to do | `docs/spec/DEVNEURAL.md` section 4 |
| Source-class multipliers | `07-daemon/src/dashboard/search-all.ts:40-46` |
| Reinforcement weights (hit gain, correction loss, decay rate) | `07-daemon/src/reinforcement/index.ts` constants |
| Decay cadence | `DEVNEURAL_DECAY_INTERVAL_MS` env var, default 24h |
| Wiki ingest cadence | `DEVNEURAL_AUTO_INGEST_INTERVAL_MS` env var, default 5 min |
| Pass 2 LLM fallback | `DEVNEURAL_PASS2_FALLBACK=anthropic` env var, default off |
| Voice mode behavior | `07-daemon/src/lex/system-prompt.ts` mode contracts |
| End-session voice command | `END_SESSION_RE` in `07-daemon/src/voice/lex-voice-ws.ts` |
| Brainstorm cwd convention | `isBrainstormCwd()` in `07-daemon/src/lex/brainstorm-store.ts` |
| Cross-project verification gate | `verifyCrossProjectFit()` in `07-daemon/src/wiki/ingest.ts` |
| Brainstorm-source weight bump | `writeNewPendingPage()` in `07-daemon/src/wiki/ingest.ts` |
| Hook silent-shim wrapping | `07-daemon/scripts/silence-all-hooks.ps1` |
| Backup target / schedule | Task Scheduler entry `DevNeural-Backup` (managed by `install-backup-task.ps1`) |
| Global no-em-dash, no-co-author rules | `~/.claude/CLAUDE.md` |
| Secret scrubbing patterns | `07-daemon/src/capture/secret-scrub.ts` |

---

*Michael Collins. Stay on the level.*
