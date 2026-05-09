# Handover — Second Brain Strengthening (2026-05-09)

> Tracking doc for the multi-item work session that strengthens the wiki/RAG/Lex pipeline and closes the session-end gap. Each item is a separate commit. Mark complete as we go.

---

## Context

DevNeural is the cross-project second brain (live capture → RAG → wiki → curator injection). Lex is the supervisory voice layer. Today's gap: brainstorm/voice sessions go through the same chunking + auto-ingest pipeline as regular Claude Code sessions, but session-end has no force-flush, the session summarizer output isn't embedded, and three known quality risks need closing.

Starting state at session boundary:
- Branch: `master`
- Last commit: `d2a2097` feat(voice): hands-free end-session command (teardown only, no RAG hookup yet)
- Working tree clean.

---

## Work items

### 1. End-session pipeline triggers (all three voice modes)

**Goal:** When a Lex voice session ends (Stop button, voice command, notes-finalize, or PTY exit), force-flush the existing wiki ingest pipeline, generate a session summary, embed it with mode metadata so meeting recordings are queryable as such.

**Touches:**
- `07-daemon/src/voice/lex-voice-ws.ts` — call session-end pipeline before sending session-end / on socket close
- `07-daemon/src/dashboard/pty-host.ts` — call session-end pipeline in PTY exit handler before `endBrainstorm()`
- `07-daemon/src/lex/brainstorm-store.ts` — surface mode in end metadata
- New: `07-daemon/src/lex/session-end-pipeline.ts` — single function that runs:
  1. `runAutoIngest(store)` for the project (force, ignore content threshold)
  2. Run/refresh `session-summarizer` for this session id
  3. Embed summarizer output into `raw_chunks` with `metadata.kind='brainstorm-summary'` and `metadata.mode=<voice mode>`
  4. `scheduleLint()` (already debounced)
- `08-dashboard/components/VoiceClient.tsx` — no change beyond existing teardown effect

**Status:** ✅ done
**Commit:** `e0b1582`

---

### 2. Audit reinforcement loop (diagnostic first)

**Goal:** Verify the hits/corrections/decay signal is actually firing. If broken, fix the signal path so wiki weights track real usage instead of drifting toward noise.

**Touches:**
- `07-daemon/src/reinforcement/index.ts` — read first to map current behavior
- `07-daemon/src/curation/curator.ts` — confirm injection produces hit signal
- SQLite `wiki_page_meta` table — sample to verify hits/corrections increment over time

**Method:**
1. Read-only investigation agent maps the current loop and reports any gaps
2. If gaps found, fix in a follow-up commit

**Status:** ✅ done
**Commit:** `9606e30`

---

### 3. Ingest LLM fallback to Anthropic

**Goal:** When local qwen3:8b produces malformed Pass-2 output (failed schema validation), retry the same call against the Anthropic API. Stays local-first by default; only falls back on validation failure.

**Touches:**
- `07-daemon/src/llm/` — add Anthropic provider if not already present
- `07-daemon/src/wiki/ingest.ts` — wrap Pass-2 call with validate-then-fallback
- `INGEST_FALLBACK=anthropic` env var to opt in
- README + install docs note the env var

**Status:** ✅ done
**Commit:** `41a68f8`

---

### 4. Cross-project promotion verification

**Goal:** When a pattern is observed in a 2nd project and is about to promote to global canonical, run a cheap LLM verification pass: "do these two evidence chunks describe the same pattern, yes/no?" Reduces false-positive global pages.

**Touches:**
- `07-daemon/src/reinforcement/index.ts` — add verification gate before promotion to canonical when `projects.length === 2`
- LLM call: tiny, cheap (Haiku or local qwen3 with low temp)

**Status:** ✅ done
**Commit:** `d9e80da`

---

### 5. Turn-bounded chunking

**Goal:** Chunk transcripts at turn boundaries (assistant `end_turn` or user message), not per-jsonl-line. A single thought stops being chopped into 20 vectors.

**Touches:**
- `07-daemon/src/capture/transcript-watcher.ts` — buffer lines until turn boundary, emit one chunk per turn (cap at 4000 chars, split if longer)
- Backfill: optional one-shot script to re-chunk recent N days of raw_chunks. Defer if disruptive.

**Risk:** biggest blast radius. Existing raw_chunks stay valid; new ones use new chunking. Search results will mix granularities for a transition window.

**Status:** ✅ done
**Commit:** `47a8510`

---

### 6. Documentation updates

**Goal:** README, installation docs, dashboard manuals, troubleshooting reflect the new end-session pipeline + fallback env var + any user-visible behavior changes.

**Touches:**
- `README.md` — update Capabilities table; note end-session pipeline
- `INSTALL.md` — note `INGEST_FALLBACK` env var if applicable
- `docs/install/02-architecture-and-dependencies.md` — diagram update if needed
- `docs/install/04-step-by-step.md` — env var setup
- `docs/install/07-troubleshooting.md` — common end-session pipeline issues
- `docs/SESSION-HANDOVER.md` — point at this handover doc for current state
- `docs/spec/devneural-v2.md` — only if architecture changed materially

**Status:** ✅ done
**Commit:** `842e3d7`

---

## Phase Two (queued)

Phase Two scope is captured in `docs/spec/FUNCTIONAL-SPEC.md` section 17. Order below is the recommended execution sequence. Do nothing here without first completing the adversarial review (item P2-0).

### P2-0. Adversarial review of FUNCTIONAL-SPEC.md ⚠ DO THIS FIRST

**Goal:** Lex (or future-me) reads `docs/spec/FUNCTIONAL-SPEC.md` end to end with a hostile mindset and writes a follow-up doc at `docs/spec/FUNCTIONAL-SPEC-REVIEW-001.md` listing every:

- **Hole** — claim made without code citation, hand-wave, "and then magic happens"
- **Contradiction** — two sections that disagree about the same behavior
- **Stale claim** — something true at write time but already obsoleted by a recent commit
- **Missing edge case** — what happens when N=0, when the daemon dies mid-pipeline, when the LLM returns empty, when the brainstorm row is missing, when whisper drops the transcript
- **Untested assumption** — anything stated as fact that has no test, no log, no smoke verification
- **Architectural concern** — places where the design will hurt at 10x scale (10x sessions, 10x wiki pages, 10x voice traffic)
- **Security gap** — anything in section 15 that's stated but not actually wired
- **Phase Two risk** — for each item in section 17, name the specific way it could go wrong

Output format: bulleted list grouped by section number from the spec. Each finding gets a one-line claim + citation + severity (`block`, `flag`, `nit`).

Do not fix anything during the review. Just enumerate. Fixes go into Phase Two items P2-1 through P2-N.

Review must include the four notes I gave at end of Phase One (commit `4e7454d`):
1. L0-L4 layered Lex awareness model (only L1 is missing)
2. Lex system prompt versioning + dials + refusal + few-shot
3. Lex feedback loop (per-turn quality marker)
4. UI fine-tuning (brainstorm rows, /wiki↔/orb deeplink, "now playing")

Plus the new Phase Two priorities below.

**Status:** ⬜ not started
**Output:** `docs/spec/FUNCTIONAL-SPEC-REVIEW-001.md`

---

### P2-1. Lex personality customization

**Goal:** Highly customize Lex's system prompt. Today it's generic. Phase Two makes it precise to how Michael actually works.

Includes:
- Personality dials (verbosity, formality, when to push back, when to defer to user, how to handle "I don't know")
- Per-mode few-shot examples showing good vs bad responses
- Refusal contract for off-topic / out-of-scope (so Lex doesn't drift into being a generic assistant)
- Version field on the system prompt (`SYSTEM_PROMPT_VERSION` constant) bumped on every change so we can roll back if Lex regresses
- Documentation of WHY each block exists, which rule it enforces, which failure mode it prevents

**Status:** ⬜ not started

---

### P2-2. L1 live awareness broadcaster (the missing layer)

**Goal:** Daemon module that maintains a live "what is everyone doing" snapshot from existing transcript-watcher state, then pushes that snapshot to Lex's PTY as a system message every 5–15s (or on significant change). Closes the gap where Lex has session context (L2) and on-demand recall (L3) but no continuous high-level awareness.

Spec target file: new `07-daemon/src/lex/awareness-broadcaster.ts`.

Snapshot must include (under ~2K tokens total):
- Active CC sessions across all projects, current phase per session (thinking / tool / idle / permission)
- Recent user prompt fragments (last N from each active session, truncated)
- Active brainstorm sessions with mode + last_summary
- Recently-emitted artifacts in last 30 min
- Currently-flagged-for-review wiki pages (so Lex can mention to user)

Push mechanism: write to Lex PTY's stdin as a system-message-shaped block that Lex's prompt knows to read on each turn. NOT prepended to every user message (that bloats context); ONE durable block updated in place.

**Status:** ⬜ not started

---

### P2-3. Lex feedback loop

**Goal:** Reinforcement signal for Lex's own responses, parallel to the wiki page reinforcement loop in section 7.

Surfaces:
- Inline thumbs up / down per turn in `08-dashboard/components/VoiceClient.tsx`
- Auto-detect strong negative cues in user's next message (regex similar to the curator correction patterns)
- Aggregate per `SYSTEM_PROMPT_VERSION` so we can A/B variants
- Dashboard surface: "Lex's worst-rated turns this week" so user catches drift early

**Status:** ⬜ not started

---

### P2-4. UI fine-tuning

Items already known:
- Brainstorm row visibility in `/sessions` and dedicated `/lex` lifecycle UI (start / end / relabel / archive)
- `/wiki` modal → orb deeplink (clicking a wiki page opens orb at that node)
- Dashboard "now playing" indicator (live active CC + brainstorm + Lex states)
- Mobile-first PWA polish (works on phone but rough edges)
- Brainstorm-as-orb-node (third node class on graph with edges to spawned wiki pages)

**Status:** ⬜ not started

---

### P2-5. Documentation refresh after P2-1 through P2-4

Update README, install docs, troubleshooting to reflect Phase Two changes.

**Status:** ⬜ not started

---

## Outstanding smoke tests

- [ ] **End-session voice command** — say "end session" in a live voice session, verify:
  - WS closes, button returns to "start voice"
  - `daemon.log` shows `[session-end] embedded brainstorm-summary mode=<...>`
  - `wiki/pending/` (or `canonical/`) gains a page if the tail content was insightful
  - `session-state/<sid>.summary.md` updated
  - First smoke test on session `7cd8670d` failed because daemon `dist/` and dashboard `out/` were stale (built before Phase 2 even shipped). Both rebuilt + daemon restarted at 16:48-16:49 on 2026-05-09. Browser may still need hard refresh for the Phase 2 `case "session-end"` client handler to load.
- [ ] **Decay scheduler** — wait 24h or hit `POST /decay`, verify SQLite `wiki_pages_meta` weights drop on rows with `last_touched_ms` past the inactivity threshold.
- [ ] **Pass 2 Anthropic fallback** — set `DEVNEURAL_PASS2_FALLBACK=anthropic` + `ANTHROPIC_API_KEY`, force a borderline-content ingest, verify `daemon.log` shows `[ingest] pass2 fallback succeeded` at least once.
- [ ] **Cross-project verifier** — surface a wiki page that has only one project in its `projects` array, run a session in a 2nd project that should add evidence to it, verify either the evidence accepts cleanly OR the page picks up `flag_for_review: true` with a verifier log entry.
- [ ] **Turn-bounded chunking** — after a long assistant turn, verify `raw_chunks_meta` shows ONE row covering that turn (not N rows), and `byte_length` reflects the merged length.

---

## Verification gates per item

Before marking complete:
- `npm run build` clean in both `07-daemon` and `08-dashboard`
- `npx tsc --noEmit` clean
- Affected tests pass (if any exist for the touched module)
- Atomic commit pushed to `master`

## Order

1 → 2 → 3 → 4 → 5 → 6. Items 2, 3, 4 can interleave or run as worktree-isolated agents if context allows. Item 5 is foundational; do it last so other items don't have to handle two chunking shapes.

---

*Started 2026-05-09. Author: collaborative session with Lex.*
