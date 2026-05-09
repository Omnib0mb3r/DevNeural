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

**Status:** ⬜ not started
**Commit:** _(pending)_

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
