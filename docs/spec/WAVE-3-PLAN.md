# Wave 3 Plan (2026-05-10 brainstorm output)

> **Origin:** Brainstorm session "Dev brainstorm season" on 2026-05-10. All decisions in this doc were locked in voice conversation between user (boss) and Lex (brainstorm-side strategist). Worker side reads this doc and executes.

---

## Headline goals

Two anchors for Wave 3:

1. **Lex-as-project-manager substrate.** Lex stays Opus 4.7. All "learning" happens in the surrounding context stack (thread docs, retrieval, memory janitor, filesystem awareness, cross-session injection). Model never changes.
2. **Unified orb.** One graph showing brainstorms + wiki pages + projects + meetings, four core node types, filter chips, double-click side panel for connections. Three.js engine and visual idiom preserved from current code.

---

## Architectural decisions (locked in brainstorm)

### Lex side

- **Model stays Opus 4.7.** Never swap. No local Qwen fine-tune, no LoRA, no Unsloth, no Ollama swap. The local Qwen 3 8B continues serving internal daemon jobs (self-audit, lint, A/B replay) as today.
- **Janitor llama** for memory consolidation runs offline, proposes merges and contradiction flags as audit findings, user approves via `/system` panel. Batched approval (not per-item) to avoid fatigue.
- **Permission tiers on personality files**, filesystem-level enforcement (not prompt-only):
  - Read-only: refusal contracts, safety prompts, voice contract
  - Read-write proposal (requires approval): feedback memories, few-shots
  - Auto-write: session logs, awareness events
- **Thread doc handoff** between brainstorms. End-of-brainstorm llama writes a short pointer-style doc: what we were working on, what we decided, what's blocked, who is Claude right now. Next brainstorm spawn injects that doc into Lex's system prompt. Pointers, not full content - Lex dereferences on demand.
- **Bounded retrieval** against past brainstorm chunks. Embedding infra already exists from Wave 2 day 3 backfill. Pull 2-3 relevant chunks per reference, no token bloat.
- **Live filesystem awareness.** Lex already has bash/grep/read via Claude Code session. Scope adds explicit "stay in lane" prompt rule plus retrieval trace observability. Grep output summarized internally before entering context.
- **Retrieval trace observability.** Dashboard surface showing what Lex retrieved at decision points so user can audit silent misses.
- **Cross-session prompt injection.** Extend RemoteTrigger so Lex can inject prompts into named live Claude Code worker sessions. Auth + allowlist + audit log per existing Phase 6 memory.
- **Curator events in live_state hook.** Audit findings, lint flags, draft conflicts surface in the UserPromptSubmit live_state injection alongside open_reminders, open_projects, active_brainstorms.
- **Internal-first retrieval bias.** Two-part fix for "Lex defaulted to web search when user said DevNeural":
  - Prompt rule: "Before any web search, check filesystem grep, brainstorm chunks, and wiki pages. External is the fallback, not the default."
  - Tool gate: middleware in voice WS that intercepts WebSearch tool calls when input contains a known-internal vocabulary term. Vocabulary list auto-generated from project registry (the same data the orb uses). Block external until internal retrieval has run.

### Orb side

- **Engine: three.js**, same as today. Worker reads existing orb code first to match visual idiom. No rewrite.
- **Four core node types** in the graph:
  - Brainstorms
  - Wiki pages
  - Projects
  - Meetings (separate from brainstorms per existing kind axis)
- **Filter chips** toggle each of the four types. Not toggles, chips - per existing memory.
- **Phases** live inside projects, only visible when project node is expanded. Not their own top-level nodes.
- **Drafts** are a state on wiki nodes (color or icon), not separate nodes.
- **Files are NEVER graph nodes.** Files appear only in the double-click side panel. Per user: individual file nodes would make the graph a mess.
- **Edges**: derivations, references, lineage. Same lineage data already in wiki frontmatter from Wave 2 day 3.
- **Double-click interaction** on any node opens a side panel listing every connected item: wiki pages, source files, projects, brainstorms, with click-to-jump on each.
- **Recent activity** highlighted via subtle pulse/glow.

### Carry-overs from Wave 2

In scope for Wave 3:
- Heartbeat watcher Windows Service script (currently empty at `07-daemon/heartbeat-watcher/`)
- Open bug docs: `docs/bugs/2026-05-10-state-tracker-loses-live-sessions.md`, `docs/bugs/2026-05-10-cc-feedback-prompt-unanswerable.md`, `docs/bugs/2026-05-10-brainstorm-picker-and-transcripts.md`

Formally punted to Wave 4:
- Crossproject_fallback UI panel
- raw_chunks_archived restore endpoint

Out of scope (different phases):
- Speaker diarization (Phase 7)
- Local fine-tune harness (rejected in brainstorm)
- Cross-host data root sync (acknowledged as gap, not Wave 3 critical)

---

## Risks flagged in brainstorm (mitigate during build)

1. **Memory budget runaway.** Thread docs + feedback memories grow unbounded. Budget cap required. Demote old to retrieval-only after threshold.
2. **Permission tier enforcement.** Soft instructions can be talked around. Use filesystem-level enforcement (chmod or separate user account), not just prompt rules.
3. **Approval fatigue.** Batched approval surface. High-risk items (guardrail-adjacent, contradictions) stay manual; low-risk merges trust-delegated.
4. **Retrieval blindness.** Retrieval trace observability surface required so silent misses are auditable.
5. **Cross-host sync.** Not blocking, but document the gap in the spec.

---

## Lane split for parallel execution

### Lane A (frontend-heavy, isolated to 08-dashboard)

**Scope:**
- Unified graph data layer: combine brainstorm_sessions + wiki_pages + projects + meetings into single node and edge set
- Three.js renderer extension to handle 4 node types, same visual idiom as current orb code (READ existing orb code first)
- Double-click side panel with all connections + file list, click-to-jump on each
- Filter chips for 4 node types
- Recent-activity glow
- Search and keyboard navigation (polish)

**First commit:** Add `Wave 3 - Orb` sub-section to `docs/spec/PHASE-TWO-IMPLEMENTATION.md` section 11 capturing this lane's scope per Wave 2 format (day-by-day if helpful, otherwise single block; steps continue from 24).

**Files touched (mostly):** `08-dashboard/**`, `07-daemon/src/dashboard/routes.ts` (new orb data endpoint), spec doc.

### Lane B (backend-heavy, mostly 07-daemon)

**Scope:**

Lex infrastructure:
- Thread doc handoff (end-of-brainstorm llama job writes pointer-style doc, injected at next spawn)
- Bounded retrieval against brainstorm chunks
- Live filesystem awareness (prompt rule + retrieval trace)
- Janitor llama job for memory consolidation (proposes audit findings, batched approval surface)
- Permission tiers on personality files, filesystem-level enforcement
- Internal-first retrieval bias (prompt rule + tool gate middleware in voice WS, vocabulary list auto-generated from project registry)
- Retrieval trace observability dashboard surface

Phase 6 cross-cutting:
- Cross-session prompt injection (RemoteTrigger extension with auth + allowlist + audit log)
- Curator events in live_state hook (extend UserPromptSubmit live_state injection)

Carry-overs:
- Heartbeat watcher Windows Service script in `07-daemon/heartbeat-watcher/`
- Bug fixes for the three docs in `docs/bugs/`

**First commit:** Add `Wave 3 - Lex` sub-section to `docs/spec/PHASE-TWO-IMPLEMENTATION.md` section 11 capturing this lane's scope per Wave 2 format. Steps continue from where Lane A left off (Lane A and Lane B should coordinate step numbering via the order they commit - whoever lands first claims the lower numbers).

**Files touched (mostly):** `07-daemon/**`, `08-dashboard/src/system/**` (curator panel + retrieval trace + approval surface).

---

## Execution rules

- **Atomic commits per item.** No bundle commits. One feature = one commit.
- **Tests + tsc green per commit.** vitest + `tsc --noEmit` clean across daemon and dashboard at every commit.
- **Stop and report when scope complete.** Do NOT proceed past lane scope into the other lane's work.
- **Merge to master after both lanes report green.** User will coordinate the merge.
- **Conflict avoidance:** Lane A owns `08-dashboard/src/orb/**`, Lane B owns `07-daemon/src/lex/**` and `08-dashboard/src/system/**`. Spec doc updates are append-only to section 11.
- **If a lane discovers a dependency on the other lane mid-execution, STOP and surface it.** Do not fork or duplicate.

---

## Acceptance criteria

**Lane A:**
- Orb renders with 4 node types and filter chips
- Double-click opens side panel with connection list and click-to-jump working
- Recent-activity glow visible on recently-touched nodes
- Three.js visual idiom preserved (no rewrite, extension only)
- All tests green, both tsc clean

**Lane B:**
- New brainstorm session spawns with thread doc injected (verify with a manual session start)
- Internal-first retrieval bias verified: Lex asked about "DevNeural" does NOT trigger web search before internal retrieval
- Janitor llama job runs and writes audit findings (verify with a forced run)
- Cross-session injection works: brainstorm-side Lex can fire a prompt into a named worker session, audit log populated
- Curator events appear in live_state output
- Heartbeat watcher service script exists and starts cleanly
- 3 bug docs resolved or formally documented as deferred
- All tests green, both tsc clean

---

## Invocation

User invocation phrase (to a worker session in `C:\dev\Projects\DevNeural` on `master`):

> Read docs/spec/WAVE-3-PLAN.md and execute Lane A (orb) and Lane B (Lex) as two parallel agents. Stop and report when both lanes are green.

The worker spawns two sub-agents per the lane split above. Each sub-agent executes its full lane scope, atomic commits, and reports back when green.
