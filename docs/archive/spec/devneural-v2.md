# DevNeural v2 Spec

> Status: design lock. Source of truth for the rewrite.
> Author: Michael Collins, with Claude.
> Last updated: 2026-05-02.

This document supersedes the v1 architecture (now archived under `archive/v1/`). v1 modules will be torn down or repurposed as described in section 13.

The companion document `docs/spec/DEVNEURAL.md` is the standing instruction set the LLM reads on every wiki operation. This spec defines the system; that document defines what gets written.

---

## 0. Identity: this is a second brain

DevNeural is a second brain. Not a tool that supports one. Not a metaphor. The identity.

A second brain has six properties. DevNeural has all six.

1. **Persistent memory across sessions, projects, and time.** Your normal brain forgets a decision you made three months ago in a different repo. DevNeural keeps it, retrievable on demand or surfaced automatically when relevant.
2. **Semantic recall, not keyword recall.** You remember the shape of a problem, not the exact words you used. DevNeural retrieves by meaning (vector embeddings), not by string match.
3. **Watches and learns without being asked.** You do not have to file things, tag things, or remember to "save this for later." Capture is automatic and continuous via Claude Code hooks and a transcript watcher.
4. **Surfaces relevant prior thinking in real time.** Not on demand. Not on search. While you are typing your next prompt to Claude, the system has already searched, decided what is relevant, and injected it as context. Claude appears smarter because it is actually informed.
5. **Compounds with use.** Every session leaves a trace. Every trace refines what the system knows is useful (reinforcement). The wiki, the weights, the cross-reference graph, the glossary all get sharper over time. The model itself does not learn (it is frozen weights); the system around it does.
6. **Lives entirely on your hardware.** Your second brain is not in someone else's data center. Local LLM (ollama). Local embedder. Local vector store. Local wiki. The only network calls leave the machine when you choose to share.

Everything that follows in this document is in service of those six properties. The wiki, the RAG layer, the dashboard (Phase 3), the orb (Phase 4) are the surfaces. The capture pipeline, ingest, query, reinforcement are the machinery. The identity is "second brain." If a design decision contradicts one of the six properties above, the design is wrong.

---

## 1. Why we are rewriting

v1 was built around **tool co-occurrence**. Every PostToolUse event incremented a 0-10 weight between project, skill, and tool nodes. The orb visualized those weights. That was noise, not signal. Knowing that you used Edit and Bash in the same session tells you nothing useful about your work.

v2 is built around **semantic concept synthesis with empirical reinforcement**. The system watches your sessions, compiles what it learns into a maintained markdown wiki of transferable insights, links pages by conceptual similarity, and injects the relevant page into Claude when you start work. Pages graduate to canonical only after they have proven useful in a real reply. Edges in the graph are real cross-reference links written by an LLM, not computed similarity scores recomputed on every query.

The orb stays as a status display. The data underneath is rebuilt from scratch.

---

## 2. End state

You open Claude in any project. Nothing is configured. The daemon already knows which project this is from your git remote. The wiki was seeded on install from your existing skills, projects, READMEs, OTLC-Brainstorm files, and historical Claude sessions, so the system is useful from the first prompt, not after months of accumulation.

As you work, hooks and a transcript watcher feed structured behavior plus prose into the daemon. A background ingest process compiles new content into the wiki: one markdown page per transferable insight, with cross-references to related pages. When you submit any prompt, a UserPromptSubmit hook fires a query against the wiki and injects the relevant page summary into Claude. Claude reads it and either uses it or does not. The system reinforces pages whose content is actually used in replies and decays pages that are ignored or contradicted.

Nightly, lint runs maintenance: merge duplicates, prune orphans, fix broken cross-refs, archive stale pages. Weekly, a reconcile pass samples canonical pages for invalidation against recent raw content. The wiki stays coherent without human maintenance.

The wiki is plain markdown on disk, version-controlled, portable, hand-readable. The orb renders it as ambient peripheral display. Session-to-session handoff documents become obsolete because the system is the persistent memory.

---

## 3. Architecture

```
+----------------------------------------------------------+
|  CAPTURE                                                  |
|   Hooks (PreToolUse / PostToolUse / UserPromptSubmit /   |
|     Stop) ---> observations.jsonl                         |
|   Transcript watcher (chokidar on                         |
|     ~/.claude/projects/<slug>/<session>/) ---> chunks    |
|   Filesystem watcher (chokidar on c:/dev/Projects/) ---> |
|     change events                                         |
|   Git watcher (HEAD / branch / commit) ---> change events|
+----------------------------------------------------------+
                          |
                          v
+----------------------------------------------------------+
|  RAW                                                      |
|   observations.jsonl (per project, append-only)           |
|   transcript chunks (per session, semantic-bounded)       |
|   change-event log                                        |
+----------------------------------------------------------+
                          |
                          v
+----------------------------------------------------------+
|  INDEX                                                    |
|   Chroma collections:                                     |
|     raw_chunks    (every transcript chunk, embedded)      |
|     wiki_pages    (every page summary + body, embedded)   |
|   SQLite index.db:                                        |
|     metadata table per collection                         |
|     FTS5 inverted index over wiki page bodies             |
+----------------------------------------------------------+
                          |
                          v
+----------------------------------------------------------+
|  BRAIN: the wiki                                          |
|   c:/dev/data/skill-connections/wiki/                     |
|     DEVNEURAL.md          schema (read by every op)       |
|     index.md              catalog of all pages            |
|     log.md                append-only audit trail         |
|     whats-new.md          weekly digest                   |
|     pages/                canonical pages                 |
|     pending/              speculative drafts              |
|     archive/              decayed-out pages, audit-kept   |
|                                                           |
|   Three operations: Ingest, Query, Lint                   |
|   One initialization: Initial corpus ingest               |
|   Cross-references in pages = graph edges                 |
+----------------------------------------------------------+
                          |
                          v
+----------------------------------------------------------+
|  SURFACES                                                 |
|   Orb (preserved from v1, rebound to wiki data model)     |
|   UserPromptSubmit injection (Query op output)            |
|   Voice interface (Query op against the wiki)             |
|   monday.com sync (devneural-projects, unchanged)         |
+----------------------------------------------------------+
```

---

## 4. Capture layer

Three independent streams, all writing into the same per-project directory under `c:/dev/data/skill-connections/projects/<project-id>/`.

### 4.1 Hooks

Registered in `~/.claude/settings.json`. All hooks invoke a single thin shell script that resolves the project ID, scrubs secrets, and appends a JSONL line.

| Hook | Phase | Captures | Used for |
|---|---|---|---|
| `PreToolUse` | `*` | tool name, input, session id, cwd | Behavior log |
| `PostToolUse` | `*` | tool name, output, session id, cwd | Behavior log |
| `UserPromptSubmit` | (n/a) | user prompt text, cwd, session id | Trigger Query op, also recorded as observation |
| `Stop` | (n/a) | session id, end time | Triggers Ingest op for the session |

Hook execution is hot-path. The hook itself only:
1. Reads stdin JSON.
2. Resolves the project ID via `git -C $cwd remote get-url origin` (hashed) with fallback to `git rev-parse --show-toplevel` then global.
3. Scrubs secrets via the regex from section 4.5.
4. Appends one line to `observations.jsonl`.
5. Bumps a signal counter and, every 20 events, sends `SIGUSR1` to the running daemon.
6. Lazy-starts the daemon if no PID file exists (see section 11).

The daemon is the one doing real work. The hook is dumb on purpose.

### 4.2 Transcript watcher

Claude Code persists every session under `~/.claude/projects/<project-slug>/<session-id>/`. Files are appended as the session progresses. The daemon runs a chokidar watcher rooted there.

When new content appears:
1. Diff against last-seen offset.
2. Chunk the new content on turn boundaries (user message, assistant message, tool block).
3. Strip code blocks larger than N lines (configurable, default 200) into separate "code chunk" records so prose embedding is not dominated by source.
4. Embed each chunk with the local embedder.
5. Persist into Chroma `raw_chunks` collection with metadata: `project_id`, `session_id`, `timestamp`, `role`, `kind` (prose / code / tool-summary).
6. Also append a compressed reference to the per-project `transcripts.jsonl` (offset, length, hash) for replay and audit.

The transcript watcher is the only path that captures Claude's prose. Hooks alone cannot.

### 4.3 Filesystem watcher

chokidar on the user's project root tree (`c:/dev/Projects/`, configurable). Records:
- file path, change kind (add/modify/delete), timestamp
- ignores `node_modules/`, `dist/`, `.git/`, and gitignored paths

Used as additional context for ingest events. Not embedded directly.

### 4.4 Git watcher

Polls `HEAD` and current branch every 30 seconds per registered project. Records:
- branch switches
- new commits (hash, message, files touched)
- worktree changes

Attached as context to ingest events ("this session ended on commit abc123 in branch feat/foo").

### 4.5 Secret scrubbing

Regex applied to all observation input/output before persistence:

```
(?i)(api[_-]?key|token|secret|password|authorization|credentials?|auth)
(["'\s:=]+)
([A-Za-z]+\s+)?
([A-Za-z0-9_\-/.+=]{8,})
```

Replacement: `$1$2$3[REDACTED]`. Per the user's CLAUDE.md, no full-secret value ever lands on disk. Project-level opt-out via a `.devneural-ignore` file at a project root: when present, capture is suppressed entirely for that project tree.

---

## 5. Storage layer

```
c:/dev/data/skill-connections/
  daemon.pid
  daemon.log
  projects.json                       # registry: id -> name, path, remote
  index.db                            # SQLite metadata + FTS5
  projects/
    <project-id>/                     # 12-char hash of git remote origin
      project.json
      observations.jsonl              # append-only, hot path
      observations.archive/           # rolled at 10MB
      transcripts.jsonl               # references into ~/.claude/projects/...
      .observer.pid
      .observer-signal-counter
      .last-purge
  global/
    observations.jsonl                # fallback when no project detected
  chroma/                             # persistent vector store
    collections/
      raw_chunks/
      wiki_pages/
  wiki/                               # see section 6
```

### 5.1 SQLite index

`index.db` holds two tables (one per Chroma collection) plus an FTS5 inverted index.

```sql
CREATE TABLE raw_chunks_meta (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- prose | code | tool-summary
  role TEXT NOT NULL,
  byte_length INTEGER NOT NULL
);
CREATE INDEX idx_raw_project_recency ON raw_chunks_meta (project_id, timestamp DESC);

CREATE TABLE wiki_pages_meta (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,        -- canonical | pending | archived
  weight REAL NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  corrections INTEGER NOT NULL DEFAULT 0,
  last_touched INTEGER NOT NULL,
  created INTEGER NOT NULL,
  projects TEXT                -- JSON array of project_ids referenced
);
CREATE INDEX idx_wiki_status_weight ON wiki_pages_meta (status, weight DESC);
CREATE INDEX idx_wiki_recency ON wiki_pages_meta (last_touched DESC);

CREATE VIRTUAL TABLE wiki_fts USING fts5(
  page_id UNINDEXED,
  title,
  trigger,
  insight,
  body,
  content='wiki_pages_meta',
  tokenize='porter'
);
```

Used for O(1) filtering, recency rerank, and keyword-precise queries that embeddings miss (function names, error codes, file paths). Maintained by the daemon on every write to a Chroma collection.

### 5.2 Retention

Files older than 30 days under `observations.archive/` are auto-purged on first hook event of the day. `transcripts.jsonl` references are never purged (cheap, audit value). Raw transcript chunks in Chroma are retained indefinitely; Chroma's storage cost is negligible at the volumes a single developer produces.

---

## 6. The brain: the wiki

This is the new layer. Everything above is plumbing.

### 6.1 Layout

```
c:/dev/data/skill-connections/wiki/
  DEVNEURAL.md               # schema, hand-editable, read on every op
  index.md                   # catalog: all pages by id, title, weight, last-touched
  log.md                     # append-only audit: ingests, queries, lints, prunes
  whats-new.md               # weekly digest, written by lint
  pages/                     # canonical pages
    choosing-pathfinding-for-grid-routing.md
    devneural-stage-changes-and-monday-sync.md
    designing-shared-data-directories.md
    ...
  pending/                   # speculative drafts (one observation, not yet promoted)
  archive/                   # decayed-out pages, kept readable for audit
```

`wiki/` gets `git init` on first daemon run. Daemon auto-commits after each ingest with message `ingest <session-id>` and after each lint with message `lint <date>`. Free history, free diffability, free recovery.

### 6.2 Page anatomy

Every page is a markdown file with this structure:

```markdown
---
id: choosing-pathfinding-for-grid-routing
title: Choosing pathfinding algorithm for grid-based routing
trigger: working on grid-based routing or AMR pathfinding
insight: prefer A* over Dijkstra when an admissible heuristic is available
summary: |
  For uniform-cost grids with an obvious heuristic (Manhattan distance),
  A* converges 3-5x faster than Dijkstra on typical warehouse layouts.
  Use Dijkstra only when costs are non-uniform and no admissible heuristic
  exists.
status: canonical
weight: 0.62
hits: 14
corrections: 1
last_touched: 2026-04-28
created: 2026-03-12
projects: [warehouse-sim, amr-router]
---

# Choosing pathfinding algorithm for grid-based routing

## Pattern
The recurring pattern, abstracted. Decision criteria, trade-offs, gotchas.

## Cross-references
- [AMR routing pathfinding](./amr-routing-pathfinding.md)
- [Conveyor capacity planning](./conveyor-capacity-planning.md)

## Evidence
- session `49d540df...` 2026-04-28: applied to dock-door clustering problem
- commit `1ebcd0c` in `warehouse-sim`: applied to bay assignment

## Open questions
- Generalize when bay sizes are non-uniform? Unresolved.

## Log
- 2026-04-28 ingest: added evidence from dock-door session
- 2026-04-15 ingest: page created
```

The frontmatter is the structured part. `summary` is the canonical injection payload (see section 6.3 Query). Body is reference. Cross-references are the edges.

### 6.3 Shape constraints

Mechanical, no LLM judgment involved. Lint enforces them.

| Constraint | Limit | What happens when exceeded |
|---|---|---|
| Title format | `[trigger] → [insight]` (parsed) | Rejected at ingest |
| Summary length | ≤ 80 tokens | LLM rewrites at next ingest |
| Body length | ≤ 800 tokens | Lint splits into two pages with cross-ref |
| Cross-refs per page | ≤ 8 | Lint flags page as too central, proposes split |
| Evidence entries | ≤ 20 | Oldest pruned (still in raw layer) |
| Frontmatter `summary` | mandatory | Page rejected without one |

Pages whose titles are nouns ("warehouse layout"), timestamps ("April 28 incident"), or entities ("warehouse-sim project") are rejected at ingest. Only pages articulating "when X applies" with "here's the insight" survive. The trigger-and-insight discipline is what keeps page granularity in the right band without requiring the LLM to decide granularity per-page.

### 6.4 No hand-authored pages, ever

Pages are produced exclusively by the ingest pipeline (initial corpus ingest, session ingest, gap-driven ingest, bypass-driven re-ingest). Hand-writing a page is not a supported workflow. Hand-editing an existing page is supported (see section 6.9).

This is a hard rule. The system is judged on whether it autonomously produces useful pages from your work. Letting humans seed pages would mask whether the autonomous system actually works.

### 6.5 Three operations

#### Ingest

Triggered by:
- `Stop` hook firing for a session (primary)
- Crossing a chunk threshold mid-session (secondary, every N tokens of new prose)
- Coverage gap signal (see section 8.5)
- Bypass signal (see section 8.6)

Steps:

1. Load `DEVNEURAL.md` schema, `index.md`, and the last K days of `log.md`.
2. Pull the new content for this trigger (transcript chunks for a session, raw chunks for a coverage-gap signal).
3. Run `git log` for the session window to attach commits.
4. Build the candidate page set with the four-signal union (see 6.6).
5. Pass 1 (Haiku, cheap): "Of these candidates, which 1-5 are actually affected, and is there a new pending page warranted?"
6. Pass 2 (Haiku, focused): Update only the surviving pages and draft any new pending page.
7. Apply diffs. Append to `log.md`. Auto-commit if wiki is git-backed.

Cost target: under 8K input tokens, under 2K output tokens per ingest. Hard ceiling: refuse to call the LLM beyond it; sample candidates if needed.

#### Query

Triggered by `UserPromptSubmit` hook on every prompt within a session (turn-by-turn).

Two-tier retrieval:

```
embed(prompt)  [5ms local]
search wiki_pages (project-filtered + global)  [10ms]
search raw_chunks (project-filtered + global)  [10ms]

if best wiki_pages cosine > 0.55:
    inject page summary (default) or body (if cosine > 0.80 and weight > 0.5)
elif best raw_chunks cosine > 0.65:
    inject the chunk verbatim with citation back to its session/file
else:
    inject nothing
```

Relevance discipline (see 6.7) bounds total injection at 600 tokens, applies a same-session reject memory, and skips injection entirely for greetings and pure-syntax questions.

Latency target: under 250ms end-to-end. No LLM call in the hot path.

#### Lint

Triggered nightly (cron via `loop` skill or Windows Task Scheduler) and on-demand via `/devneural-lint`.

Sample, don't sweep:

- All `pending/` pages
- All canonical pages with `weight < 0.2`
- 50 random canonical pages
- All pages flagged for review since last lint

Checks per sampled page:
- Pages in `pending/` older than 30 days with one supporting session: archive.
- Canonical pages with `weight < 0.15` and `last_touched > 90 days`: archive.
- Two pages with cosine > 0.85 and overlapping evidence: propose merge (Sonnet pass).
- Pages with no incoming cross-references: flag as orphan.
- Broken cross-reference links: fix or remove.
- Frontmatter contradictions across pages: flag for human review.
- Shape constraint violations from 6.3: auto-apply fixes (split, prune evidence, rewrite summary).

Output: a `lint-report.md`. Auto-applies safe actions. Holds risky ones (merges, deletions) for explicit `/devneural-lint --apply`.

A weekly **reconcile pass** (separate cadence) picks 25% of canonical pages at random and asks Sonnet "does any recent transcript chunk contradict, supersede, or substantially extend this page." Flags candidates for re-ingest. Over a month, every canonical page gets reconciled. Bounded cost, guaranteed eventual coverage.

### 6.6 Candidate page selection at ingest

Replaces "top K by embedding" with a multi-signal union. None requires an LLM.

```
candidates = ∅
candidates ∪= top_k_embedding(new_content, k=15)
for c in candidates:
  candidates ∪= cross_ref_neighbors(c, hops=1)
candidates ∪= top_k_entity_overlap(new_content, k=10)
candidates ∪= top_k_fts(extracted_keywords, k=5)
```

The four signals catch four different failure modes:
- **Embedding** catches semantic similarity in the same vocabulary
- **Graph hops** catch transitive relevance through cross-references
- **Entity overlap** catches literal matches on file paths, commit hashes, function names, project IDs
- **FTS** catches keyword-precise hits embeddings miss (jargon, identifiers)

Total candidate set lands at 30-50 pages. Pass 1 of ingest filters to 1-5 actually affected. Pass 2 updates only those.

### 6.7 Relevance discipline at injection

Injection rules, applied after the two-tier retrieval in section 6.5 Query:

| Rule | Setting | Why |
|---|---|---|
| Cosine floor for wiki match | 0.55 | Below this, injection is noise |
| Cosine floor for raw match | 0.65 | Higher bar because raw chunks lack synthesis |
| Default payload | page `summary` field (≤ 80 tokens) | Compact, focused on the trigger and insight |
| Body inclusion | only when wiki cosine > 0.80 AND page weight > 0.5 | Strong match plus proven page |
| Token budget per injection | 600 total | Hard cap across all injected pages and chunks |
| Diversity | drop second match if it is > 0.85 cosine to the first | Avoid telling Claude the same thing twice |
| Prompt-type filter | skip injection for prompts ≤ 5 words, greetings, pure-syntax questions | Cheap heuristic up front |
| Same-session reject memory | a corrected page is blacklisted for the rest of the session | Don't repeat a mistake |

These thresholds are the lever for tuning relevance over time. Edit this section, not the operations.

### 6.8 Initial corpus ingest

Runs once on first daemon launch. Bounded background pass that seeds the wiki from your existing knowledge.

Sources, in order of priority:

1. `~/.claude/skills/**/SKILL.md` and `~/.claude/plugins/**/skills/**/SKILL.md`. Each existing skill becomes a candidate page: trigger derived from `description` and `when_to_use` sections, insight derived from "use the skill at <path>".
2. `c:/dev/Projects/*/devneural.jsonc`, `c:/dev/Projects/*/README.md`, `c:/dev/Projects/*/CLAUDE.md`, `c:/dev/Projects/*/OTLC-Brainstorm.MD`. Project metadata and design intent. Each project becomes one or more candidate pages on patterns and decisions documented there.
3. `~/.claude/projects/*/*` (existing Claude session transcripts). Replayed through the same ingest pipeline as new sessions.
4. Recent commits across active repos (last 6 months).

Result: by the end of the initial ingest pass, the wiki has hundreds of seeded pages reflecting your existing work. Pages live in `pending/` until they meet promotion criteria, but they are immediately searchable for Query, so injection works from your first prompt after install.

Triggered manually via `/devneural-reseed` if you add a major new corpus.

### 6.9 Hand-edits to existing pages

Hand-editing the markdown of an existing page is supported. The daemon detects the edit (chokidar on `wiki/`) and:

1. Re-embeds the page.
2. Marks frontmatter `human_edited: true` and `human_edited_at: <timestamp>`.
3. Sets `weight` to `max(weight, 0.5)` (treating a human edit as a strong implicit endorsement).
4. The next ingest that would touch this page checks `human_edited` and treats your edits as protected: it can ADD evidence, ADD cross-references, and ADD a log entry, but cannot rewrite `summary`, `trigger`, `insight`, `## Pattern`, or `## Cross-references` without flagging the page for human review first.
5. Lint never auto-applies destructive changes to a human-edited page.

Hand-editing is for correcting the system, not for seeding it.

---

## 7. The two layers: semantics and logic

DevNeural is built on two complementary layers. Both are required. Neither alone is sufficient.

### 7.1 The semantics layer (meaning-based)

This is the fuzzy half. It uses vector embeddings to capture meaning rather than words.

Components:
- **Local embedder** (`Xenova/all-MiniLM-L6-v2`, 384-dim, normalized vectors). Runs in-process via ONNX. No API.
- **Three Chroma collections** (in-process, persisted as packed Float32 + metadata sidecars):
  - `raw_chunks` — every transcript chunk, every meaningful capture
  - `wiki_pages` — every wiki page (canonical + pending) embedded by title + summary + body
  - `reference_chunks` (Phase 3) — every external doc upload (PDF / image / audio / video transcript)
- **Cosine similarity search** with project-id and kind metadata filters
- **Two-tier retrieval at query time**: wiki first (cosine > 0.55), raw fallback (cosine > 0.65), reference as tertiary
- **FTS5 keyword index** in SQLite for terms that embeddings miss (function names, error codes, specific identifiers)
- **Multi-signal candidate selection at ingest** (cosine + cross-ref hops + entity overlap + FTS keyword)

This is what lets you ask "the warehouse layout decision" three months later and get back work where you didn't use those exact words. It is associative recall.

### 7.2 The logic layer (rules-based)

This is the strict half. It enforces what counts as a real insight, when something can be promoted, when it should be archived.

Components:
- **Page schema discipline**: title format `[trigger] → [insight]`, summary ≤ 80 tokens, body ≤ 800 tokens, ≤ 8 cross-references, ≤ 20 evidence entries, mandatory frontmatter fields (see DEVNEURAL.md sections 2 and 7)
- **Validation gates at every LLM output**: schema-checked, repaired-and-retried up to N times, dropped on failure (see `07-daemon/src/llm/validator.ts`)
- **Promotion criteria** (pending → canonical): recurrence (same trigger seen in a meaningfully different situation) OR useful retrieval (injected and used in a reply with no correction)
- **Reinforcement rules**: HIT raises weight by `(1 - w) * 0.05`; CORRECTION lowers by `w * 0.10`; passive decay `w *= 0.995` per session of non-use; archive at `w < 0.15` plus age threshold
- **Speculation tier**: new patterns live in `pending/` until they prove themselves. Empirical proof, not human judgment, decides promotion.
- **Five-layer self-loop guards** (see section 11.2) prevent the daemon from observing the LLM-driven sessions it spawns
- **Hard rules in DEVNEURAL.md section 7**: do not invent (every claim cites evidence), do not synthesize across projects without grounding (multi-project promotion requires evidence from at least two), do not overwrite human edits, do not chase volume

This is what keeps the wiki from becoming a junk drawer. It is the editorial discipline.

### 7.3 How they work together

| Phase | Semantics does | Logic does |
|---|---|---|
| Capture | Embeds prose chunks into raw_chunks | Scrubs secrets, gates by self-loop guards |
| Ingest candidate selection | Cosine, FTS, graph-hop union | Caps the candidate pool at 50 |
| Ingest pass 1 (filter) | LLM reads candidates by relevance | Schema-validates the JSON output, retries on failure |
| Ingest pass 2 (write) | LLM proposes new pending page | Hard-rejects if title lacks `→`, if no evidence, if oversize |
| Query | Embeds prompt, finds nearest pages | Floors out below 0.55 cosine, prefers canonical, applies same-session blacklist, caps at 600-token budget |
| Reinforce | Embeds reply, computes overlap with injected page | Applies `(1-w)*0.05` hit rule, demotes on correction, decays slowly |
| Lint | Embedding clusters proposed for merge | Schema repairs auto-applied, merges flagged for explicit confirm |

Without semantics: you have a junk drawer of insights nobody can find. Without logic: you have a vector store of unstructured noise that scores high but means nothing.

The combination is what makes the wiki a *brain* and not just a database.

---

## 8. Learning loop

Six mechanisms make this an actual learning system.

### 8.1 Provenance per claim

Every line in `## Evidence` cites a session id, file path, or commit hash. Pages with no evidence are ineligible for promotion from `pending/`. Lint flags pages whose evidence has been deleted from disk.

### 8.2 Speculation tier (pending → canonical)

A new pattern observed once goes to `pending/`. Promotion requires ONE of:

- **Recurrence:** the same trigger is invoked in a meaningfully different situation. Confirmed when ingest links a new session's content to the page with high overlap.
- **Useful retrieval:** Query op pulls the page, the reply uses it (see 7.3), no correction follows.

Either condition promotes to canonical. The recurrence path is the conservative bootstrap (matching ECC's project → global model). The useful-retrieval path is the aggressive bootstrap (the page proved itself in production immediately). Both are valid signals; either is sufficient.

### 8.3 Reinforcement signal

When a page is injected at query time, the daemon waits for the next assistant reply, then checks:

- Reply contains content semantically similar to the injected page summary (cosine > 0.65)? **Hit.** Increment `hits`, raise `weight` by `(1 - weight) × 0.05`.
- User's next message corrects the assistant (heuristic: contains "no", "actually", "wrong", or a tool call that reverts a previous one within N turns)? **Correction.** Increment `corrections`, lower `weight` by `weight × 0.10`. Add page to same-session reject memory.
- Otherwise: decay slowly. `weight *= 0.995` per session of non-use.

`weight` floors at 0 and ceilings at 1. Pages whose `weight` falls below 0.15 are eligible for lint-archive.

### 8.4 Self-query closing the loop

After a session ends and reinforcement runs, for any page that was injected and used, the daemon optionally asks Haiku one cheap question per page: "did this page help, what was missing, what should be added." The answer appends to the page's `## Log` section. Disabled by default; enable with `observer.self_query.enabled` in config.

### 8.5 Coverage gap signal

When a Query op finds a strong hit in `raw_chunks` but no `wiki_pages` page above the floor, the topic is hot in raw content but uncovered by the wiki. The daemon records a `coverage-gap` event. When 3+ gaps accumulate on similar content (cosine clustering), an ingest pass is triggered with the matching raw chunks as input. The result is one or more new `pending/` pages compiling the gap into transferable insight.

This is the mechanism by which the wiki self-bootstraps: it writes new pages on demand when the system notices it lacks coverage for things the user is actually asking about.

### 8.6 Bypass signal

When a Query hits in both collections, but the raw chunk score outranks the closest wiki page by > 0.10, the existing wiki page is stale or incomplete on this topic. Daemon flags the page for re-ingest. The flag is consumed at the next ingest pass, which rewrites the page with the new content folded in.

### 8.7 What's-new digest

Lint writes `wiki/whats-new.md` weekly. Format:

```markdown
# What's new — week of 2026-04-26

## Created (5 new pending pages)
- ...

## Promoted (2 pages → canonical)
- ...

## Reinforced (12 pages saw action)
- weight ↑: ...
- weight ↓ (corrections): ...

## Archived (3)
- ...

## Coverage gaps closed (2)
- ...

## Notable retrievals
- prompt "X" → page Y → reply used it. (high-confidence hit)
- prompt "Z" → no match. (potential coverage gap)
```

This is your weekly view into how the system is learning. Replaces the "browse the orb to see what's happening" use case with something more useful.

---

## 9. Surfaces

### 9.1 Orb (preserved, downgraded in priority)

The Three.js orb in `03-web-app/` keeps its visual code: force layout, edge heat, pulses, dendrites, single-click highlight, double-click open. Rebound to the wiki data model:

| Old | New |
|---|---|
| Node = project, skill, or tool | Node = wiki page |
| Edge = co-occurrence count | Edge = explicit cross-reference link in markdown |
| Edge weight = log-normalized usage | Edge weight = max(weight) of the two endpoint pages |
| Node color = stage badge | Node color = page weight (cool to warm) |
| Node label = project name | Node label = page title |

Single-click highlights the page and its 1-hop neighbors. Double-click opens the markdown page in VS Code. The orb is ambient peripheral display, not the daily-driver UI. Daily UI is `whats-new.md` and the injection itself.

### 9.2 Context injection

`UserPromptSubmit` hook calls a small `query` binary that talks to the daemon over local socket, gets back a markdown blob (the top page summary, possibly a raw chunk fallback), and writes it to the hook's stdout in the format Claude Code expects for additional context. Per-prompt, every turn within a session.

### 9.3 Voice interface

`05-voice-interface` reshapes from "graph queries" to "wiki queries." Calls the same Query op. Returns the matching page's summary as voice output. STT in, daemon Query, TTS out.

### 9.4 Project status board (formerly monday.com sync; deprecated)

`devneural-projects` is unchanged. The `POST /sync` endpoint is the only thing the daemon needs to expose for compatibility. URL stays `http://localhost:3747/sync`.

### 9.5 NotebookLM / Obsidian sync

`06-notebooklm-integration` reshapes to "publish wiki pages to Obsidian." One-way sync: copy `wiki/pages/` into the configured Obsidian vault path with a small frontmatter transform. NotebookLM-specific cluster detection is replaced by "send the highest-weight pages."

---

## 10. Project identity

Project ID is a 12-character hash of `git remote get-url origin` (lowercased, trailing slash stripped, `.git` stripped). Same repo cloned on different machines yields the same ID.

Fallback chain when no git remote:
1. `git rev-parse --show-toplevel` hashed → machine-specific id
2. Global scope (`global`) → no project context

A registry at `c:/dev/data/skill-connections/projects.json` maps id → human name, root path, remote URL, first-seen timestamp. Updated lazily by the daemon.

`devneural.jsonc` continues to exist for **stage and tags only** (editorial fields used by `devneural-projects` for monday.com sync). It is no longer the source of project identity for DevNeural. Drop the dependency on `localPath` and `githubUrl` for graph identity. Keep the file because monday.com sync still needs it.

---

## 11. Daemon lifecycle

Single daemon process per machine. Long-running. Owns Chroma, the wiki, SQLite index, and the WebSocket server.

### 11.1 Start

Lazy. The first hook event after a reboot or daemon crash:
1. Check `c:/dev/data/skill-connections/daemon.pid`.
2. If file exists, validate the PID is alive. If dead, remove the stale file.
3. Acquire a `flock`-style atomic lock (Windows: `mkdir`-based atomic lock).
4. Spawn the daemon: `node c:/dev/Projects/DevNeural/07-daemon/dist/daemon.js` detached, output redirected to `daemon.log`.
5. Write the new PID to `daemon.pid`. Release the lock.

### 11.2 Self-loop guards

The daemon calls Claude (Haiku for ingest, Sonnet for lint, optional Haiku for self-query). Those calls produce hooks. Without guards, observation spirals.

Five-layer guard, lifted from ECC's `continuous-learning-v2` and adapted:

| Layer | Check |
|---|---|
| 1 | `CLAUDE_CODE_ENTRYPOINT` env must be `cli`, `sdk-ts`, or `claude-desktop`. |
| 2 | `DEVNEURAL_HOOK_PROFILE=minimal` env skips all observation hooks. |
| 3 | `DEVNEURAL_SKIP_OBSERVE=1` env: cooperative skip for daemon-spawned sessions. |
| 4 | Hook input contains `agent_id` (subagent) → skip. |
| 5 | `cwd` matches `DEVNEURAL_OBSERVE_SKIP_PATHS` (default: `daemon-sessions,.devneural-mem`) → skip. |

The daemon sets `DEVNEURAL_SKIP_OBSERVE=1` on every Anthropic SDK call it makes.

### 11.3 Stop

`/devneural-stop`, or signal the PID. Daemon traps `SIGTERM` and `SIGINT`, flushes Chroma, closes the wiki git repo if dirty, removes its PID file.

### 11.4 Throttle

Hook signals the daemon every 20 events. Daemon coalesces signals: it does not start a new ingest while one is running. New events accumulate in `observations.jsonl` and are picked up on the next pass.

---

## 12. Tech stack

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript / Node 20+ | Reuse existing 03-web-app stack and 01-04 infrastructure. |
| Embedder | `@xenova/transformers` running `Xenova/all-MiniLM-L6-v2` (or upgrade to `all-mpnet-base-v2`) locally, ONNX | No API cost, fast, runs in Node. |
| Vector store | Chroma (`chromadb` JS client against a local `chroma run` instance) | Persistent, supports metadata filters. |
| Metadata + FTS | SQLite via `better-sqlite3` | Synchronous, fast, ships with Node, native FTS5. |
| LLM for Ingest | `claude-haiku-4-5` | High frequency, cheap. |
| LLM for Lint (merges, contradictions) | `claude-sonnet-4-6` | Low frequency, needs reasoning. |
| LLM for Reconcile (weekly) | `claude-sonnet-4-6` | Same. |
| LLM for Query injection | None at hot path. Embedding similarity only. | Latency budget. |
| Daemon HTTP | Fastify | Already familiar. |
| Daemon WebSocket | `@fastify/websocket` | Same. |
| File watching | chokidar | Already used. |
| Wiki versioning | `git init` in `wiki/`, auto-commit per ingest and per lint | Free history. |
| Process model | Single Node process, lazy-started by hook | Simplest possible. |

---

## 13. Migration

### 13.1 What dies

| Path | Action |
|---|---|
| `01-data-layer/src/hook-runner.ts` and weights logic | Move to `archive/v1/`. Replaced. |
| `01-data-layer/src/weights/`, `01-data-layer/src/logger/` | Move to `archive/v1/`. |
| `02-api-server/src/server.ts` and weights routes | Move to `archive/v1/`. Replaced by daemon HTTP. |
| `02-api-server/src/watcher/` (devneural.jsonc scan) | Move to `archive/v1/`. Project identity comes from git remote. |
| `02-api-server/src/monday/` | Port to `07-daemon/src/surfaces/monday/`. Same `POST /sync` contract, same URL. |
| `04-session-intelligence/src/session-start.ts` | Move to `archive/v1/`. Replaced by UserPromptSubmit + Query. |
| `04-session-intelligence/src/install-hook.ts` | Repurpose into the new `install-hooks` script wiring all four hooks. |
| v1 weights at `c:/dev/data/skill-connections/weights.json` | Archive to `weights.json.v1.bak`. v2 starts cold. |

### 13.2 What lives

| Path | Action |
|---|---|
| `03-web-app/` Three.js orb shell, force layout, edge heat, pulses, dendrites, interaction handlers | Keep. Rebind to wiki data model. |
| `01-data-layer/src/identity/` (path-to-project resolution) | Port concepts to `07-daemon/src/identity/` with hashed git remote. |
| `01-data-layer/src/schema/devneural-config.ts` (devneural.jsonc validation) | Keep. monday.com sync still needs it. |
| `devneural-projects` repo | Untouched except `POST /sync` URL pointing at the new daemon (same port 3747, same path). |
| `scripts/fill-devneural.mjs` SessionStart hook in `devneural-projects` | Untouched. |

### 13.3 What is new

| Path | Purpose |
|---|---|
| `07-daemon/` | New module. The daemon. Owns capture, ingest, query, lint, the wiki, Chroma, SQLite, the WebSocket. |
| `07-daemon/src/hooks/` | The thin shell scripts wired into `~/.claude/settings.json`. |
| `07-daemon/src/wiki/` | Ingest, query, lint, reconcile operations, page schema, frontmatter parser. |
| `07-daemon/src/embedder/` | Local ONNX-based embedding. |
| `07-daemon/src/chroma/` | Chroma client wrapper, collection management. |
| `07-daemon/src/index_db/` | SQLite metadata + FTS5 maintenance. |
| `07-daemon/src/identity/` | Hashed git remote, project registry. |
| `07-daemon/src/llm/` | Anthropic SDK wrapper, prompts for ingest/lint/self-query/reconcile. |
| `07-daemon/src/corpus/` | Initial corpus ingest scanner (skills, projects, sessions, commits). |
| `c:/dev/data/skill-connections/wiki/` | The wiki itself. Created by daemon on first run. Schema in `DEVNEURAL.md`. |
| `c:/dev/data/skill-connections/chroma/` | Chroma persistent store. |
| `c:/dev/data/skill-connections/index.db` | SQLite metadata + FTS5. |

### 13.4 Build order

All eight phases are day-one scope. There is no MVP cut. Phases exist as a sequencing tool because some depend on others; not as a scope-cutting tool.

| Phase | Scope | Verifies |
|---|---|---|
| **P0** | Write `docs/spec/DEVNEURAL.md` schema document. Iterate until it produces clean pages on a small test corpus. | The LLM writes consistent, transferable pages from real input. |
| P1 | Capture: project ID, hooks, observations.jsonl, transcript watcher, fs watcher, git watcher, secret scrub | Every tool call and every assistant turn lands on disk with correct project ID, no leaked secrets |
| P2 | Daemon scaffolding + Embedder + Chroma + SQLite index | Searching either Chroma collection for a recent chunk returns it; SQLite filters work |
| P3 | Initial corpus ingest + Session ingest with multi-signal candidates and `[trigger] → [insight]` rule | Running on existing skills/projects produces real pending pages with cited evidence |
| P4 | Promotion + Query (two-tier retrieval, relevance discipline) + UserPromptSubmit injection | Asking Claude something covered by a seeded page surfaces it; the reply visibly leans on the injection |
| P5 | Reinforcement + Coverage gap + Bypass signals + Self-query | Repeated useful injection raises weight; raw-only hits trigger new page creation |
| P6 | Lint (sample + auto-apply safe) + Weekly reconcile + Whats-new digest | Stale pending archived; orphan canonical flagged; weekly digest reflects real activity |
| P7 | Orb rebind to wiki data model | Orb renders pages and edges, animates on diff |
| P8 | Voice interface + Obsidian sync | Voice returns page summaries; Obsidian vault mirrors `wiki/pages/` |

Each phase ships fully working. P0 comes before P1 because the entire system reads `DEVNEURAL.md`; if that document is wrong, every page drifts.

---

## 14. File layout (final)

```
c:/dev/Projects/DevNeural/
  03-web-app/                     # orb, kept, rebound
  05-voice-interface/             # reshaped to query Wiki
  06-notebooklm-integration/      # reshaped to Obsidian sync
  07-daemon/                      # new, the brain
    src/
      capture/
        hooks/
        transcript-watcher.ts
        fs-watcher.ts
        git-watcher.ts
        secret-scrub.ts
      identity/
        project-id.ts
        registry.ts
      raw/
        observations.ts
        transcripts.ts
      embedder/
      chroma/
      index_db/
      corpus/
        skills.ts
        projects.ts
        sessions.ts
        commits.ts
      wiki/
        schema.ts                 # frontmatter + cross-ref parser
        ingest.ts
        query.ts
        lint.ts
        reconcile.ts
      llm/
        haiku.ts
        sonnet.ts
        prompts/
          ingest.md
          lint.md
          reconcile.md
          self-query.md
      surfaces/
        http.ts                   # POST /sync etc.
        websocket.ts
        socket.ts                 # local socket for hooks
        monday/                   # ported from 02-api-server
      lifecycle/
        pid.ts
        guards.ts
        signals.ts
      daemon.ts                   # entrypoint
    tests/
    package.json
    tsconfig.json
  docs/
    spec/
      devneural-v2.md             # this file
      DEVNEURAL.md                # wiki schema (companion)
  archive/
    v1/                           # 01, 02, 04 archived here on teardown
  devneural.jsonc                 # kept, narrowed to stage + tags
  README.md                       # rewritten

c:/dev/data/skill-connections/
  daemon.pid
  daemon.log
  projects.json
  index.db                        # SQLite metadata + FTS5
  projects/<id>/
    project.json
    observations.jsonl
    observations.archive/
    transcripts.jsonl
    .observer.pid
    .observer-signal-counter
    .last-purge
  global/
    observations.jsonl
  chroma/
    collections/
      raw_chunks/
      wiki_pages/
  wiki/
    DEVNEURAL.md                  # runtime copy of docs/spec/DEVNEURAL.md
    index.md
    log.md
    whats-new.md
    pages/
    pending/
    archive/
    .git/                         # auto-versioning
```

---

## 15. Operator commands

| Command | Effect |
|---|---|
| `/devneural-status` | Daemon liveness, project counts, page counts (canonical / pending / archived), last ingest, last lint |
| `/devneural-ingest` | Force an ingest pass for the current project, bypass throttle |
| `/devneural-query <text>` | Manual Query op. Print the page that would be injected. |
| `/devneural-lint` | Run lint, print proposed actions, do not apply |
| `/devneural-lint --apply` | Run lint and apply all safe + flagged actions |
| `/devneural-reconcile` | Force the weekly reconcile pass on demand |
| `/devneural-reseed` | Re-run initial corpus ingest |
| `/devneural-promote <page-id>` | Manually promote a page from `pending/` to canonical |
| `/devneural-archive <page-id>` | Manually archive a canonical page |
| `/devneural-stop` | Stop the daemon |
| `/devneural-restart` | Restart the daemon |
| `/devneural-export` | Tar up `wiki/` for backup |
| `/devneural-import <path>` | Merge an exported wiki into the current one |

---

## 16. Non-goals and explicit out-of-scope

- **Multi-user collaboration on a shared wiki.** v2 is single-machine, single-user.
- **A web-hosted version on `onthelevelconcepts.com`.**
- **A "global" cross-developer instinct library.** Privacy and content sensitivity make it explicitly out.
- **Automatic skill / command generation.** ECC's `/evolve` does this. We do not. Wiki pages stay as pages.
- **Detection of "you are done with a task."** Replaced by decay.
- **Hand-authored pages.** All pages produced by ingest. Hand-edits to existing pages are supported (section 6.9).

Note: per-prompt mid-session injection is **in scope**, not a non-goal. UserPromptSubmit fires every prompt within a session.

---

## 17. Open questions deliberately left unresolved

These do not block P0-P5 but need answers before P6:

1. **Lint cadence on a laptop that sleeps.** Cron does not fire while suspended. Need a wake-on-resume hook or a "lint if last lint > 24h" check at daemon startup.
2. **Cross-machine wiki sync.** If Michael uses two machines, the wiki diverges. `git push` on a wiki repo is a clean answer but introduces conflict resolution. Defer until it bites.
3. **Reinforcement and reconcile thresholds.** Cosine 0.55 / 0.65 / 0.85 / 0.10 are starting values. Calibrate against logged hit/miss data after P5.
4. **Daemon as Windows service vs. lazy-spawned process.** Lazy spawn is simpler. If reliability under reboot becomes an issue, register as a service.
5. **Corpus ingest of paid-for / sensitive client work.** `.devneural-ignore` at project root suppresses capture, but initial corpus ingest of an existing tree predates the file's existence. Provide an explicit `--exclude <path>` flag for first run.

---

## 18. Acknowledgements

- ECC `continuous-learning-v2` skill (Affaan Mustafa) for the hook capture pattern, observations.jsonl format, project-id-via-hashed-remote, lazy daemon spawn with PID + flock, five-layer self-loop guard, secret scrub regex, and the recurrence-based promotion model. Architectural concepts adopted, no code copied.
- Andrej Karpathy's "LLM Wiki" gist for the compiled-not-retrieved knowledge model. The brain layer is his.
- v1 DevNeural orb code (this repo) for the visual surface preserved through the rewrite.

---

*Michael Collins. Stay on the level.*
