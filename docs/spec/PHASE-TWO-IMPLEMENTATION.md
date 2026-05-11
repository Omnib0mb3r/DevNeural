# DevNeural Phase Two Implementation Spec

> Authoritative implementation spec for Phase Two of DevNeural, derived from `voice-review.md` (2026-05-10).
>
> **Scope:** every committed decision in `voice-review.md` translated into concrete data model deltas, API contracts, UI components, telemetry schemas, intra-wave step ordering, rollback steps, and test cases. This file is what a Claude Code session reads at start of day to execute Phase Two with minimal disambiguation.
>
> **Companion documents (do not duplicate, just reference):**
> - `voice-review.md`: rationale and decisions (the "why")
> - `docs/spec/devneural-v2.md`: existing architecture (the "what is")
> - `docs/spec/DEVNEURAL.md`: wiki schema config (the "what the LLM follows")
> - `docs/spec/FUNCTIONAL-SPEC.md`: existing functional spec (gets a delta added in Wave 1)
> - `docs/SESSION-HANDOVER.md`: most recent session boundary state
>
> **Replaces:** the Phase Two queue (P2-0 through P2-5) in `TODO.md`. Once Wave 1 lands, update `TODO.md` to point here.
>
> **Conventions in this document:**
> - Effort estimates assume one focused day equals about 6 working hours.
> - File paths are absolute Windows paths from the repo root, e.g. `07-daemon/src/...`.
> - "Verify on day 1" markers flag places where this spec assumes a current-code shape that should be confirmed before coding (the spec author did not have full visibility into every file).
> - No em dashes anywhere. No AI co-author tags on commits.

---

## Table of contents

1. Identity and goals
2. Authoritative decisions (consolidated)
3. Data model deltas
4. API contracts (new + modified)
5. UI components and routes
6. Configuration and environment variables
7. Privacy boundary (outbound)
8. Telemetry and observability schemas
9. Test plan
10. Wave 1 execution
11. Wave 2 execution
12. Wave 3 execution
13. Stopping criteria and verification
14. Rollback and recovery
15. Open questions and day-1 verifications
16. Appendix A: file index
17. Appendix B: commit message templates
18. Appendix C: Database choice and Postgres migration path
19. Appendix D: System interconnect (sequence diagram)
20. Appendix E: Worked example, brainstorm session lifecycle
21. Appendix F: Worked example, curator decision lifecycle
22. Appendix G: Domain-distance taxonomy (proposal)
23. Appendix H: Confidence formula for wiki drafts
24. Appendix I: Heartbeat watcher service
25. Appendix J: Performance budget
26. Appendix K: Concurrency and boot sequence
27. Appendix L: Error handling matrix
28. Appendix M: Logging conventions
29. Appendix N: Build, CI, and nightly jobs
30. Appendix O: Security threat model
31. Appendix P: Glossary
32. Appendix Q: Day-1 startup script for Claude Code
33. Appendix R: Lex three-level context model and awareness budget

---

## 1. Identity and goals

DevNeural is **agentic personal infrastructure** for one user. The user is a **brainstormer-first**: voice brainstorm conversations are the substrate of how the user thinks, and they are equal-or-higher priority than project transcripts and polished wiki content.

Phase Two has three parallel tracks:

- **Track A: brainstorm-first build-out.** Make brainstorms first-class everywhere (retrieval, decay, privacy, dashboard, lineage, orb).
- **Track B: wiki-proof and observability.** Instrument the curator and reinforcement loop so the compounding-intelligence claim is measurable, not aspirational. Steal three patterns from Karpathy.
- **Track C: Lex critical path.** Lex personality customization and feedback loop, decoupled from A and B.

Phase Two ends when **stopping criteria** in section 13 are all green over the windows specified.

---

## 2. Authoritative decisions (consolidated)

This is the single source of truth for Phase Two design decisions. If `voice-review.md` and this section ever diverge, this section wins for implementation. `voice-review.md` retains the rationale.

### 2.1 Brainstorm-first

| ID | Decision |
|---|---|
| BF-1 | Source-classed retrieval order changes to: `brainstorms > canonical wiki > pending drafts > project transcripts > generic raw > reference`. Weights are per-source-class numeric; default ratios in section 4.2. |
| BF-2 | Brainstorm transcripts and brainstorm summaries never decay. Reinforcement decay scheduler scope tightens to wiki pages only. |
| BF-3 | Full brainstorm transcripts are searchable forever via a `brainstorm_chunks` storage shape (table or tag, see section 3.2). Summaries remain as a separate fast retrieval target; both coexist. |
| BF-4 | Brainstorm content is the highest sensitivity privacy class. Pass 2 Anthropic Haiku fallback is forbidden for brainstorm content even with the opt-in flag set. Cross-project verifier is forbidden for any wiki page whose source list contains a brainstorm. Enforced in code, asserted by tests. |
| BF-5 | First-class top-level `/brainstorms` dashboard route with detail page, filters, audio playback, and lineage. |
| BF-6 | Project-less brainstorms live in a `general` namespace. `brainstorm_sessions.project_slug` is nullable; null sessions are surfaced under `general`. |
| BF-7 | Wiki distillation at brainstorm session end is **automatic**, not user-triggered. The session-end pipeline runs Pass 2 against the full transcript and writes pending wiki drafts. The user reviews drafts in `/drafts` (promote, edit, discard). After N days idle, drafts above a confidence threshold auto-promote, drafts below auto-drop. A manual "force re-distill" admin action is retained but not the primary path. |
| BF-8 | Cross-brainstorm auto-link via vector-similarity edges between session summaries above a tunable threshold. |
| BF-9 | Orb is a **single unified graph**. Brainstorms, wiki pages, and projects (where they have node density) are all first-class nodes. Edges span all node types. Node visual style differentiates type. Filter chips can hide types, but the underlying graph is one graph, not layers behind a toggle. |
| BF-10 | "What was I thinking" is a first-class query mode. Lex command and dashboard search filter that searches brainstorms first, derived artifacts second, wiki third. |
| BF-11 | Audio is retained at `data/brainstorms/<id>/audio/` as the source bundle (WAV or OGG depending on capture). Dashboard exposes a playback control on every brainstorm session detail page. Configurable max-age and opus compression for retention cost management. |
| BF-12 | Brainstorm KPI tiles added to the dashboard KPI strip. |
| BF-13 | One-shot `npm run backfill-brainstorms` script re-ingests pre-2026-05-09 sessions into the new shape. |
| BF-14 | **Voice sessions have a `kind` axis: `brainstorm` or `meeting`.** Brainstorm = solo ideation in `conversation` or `push-to-talk` modes. Meeting = third-party-voice capture in `notes` mode. The two kinds have different distillation pipelines, different retrieval priority, different privacy treatment for audio, and different Lex prompts. The default `kind` for a `notes`-mode session is `meeting`; the user can override at session creation. |
| BF-15 | **Meetings produce `meeting-summary` artifacts plus action-item reminders, NOT wiki drafts by default.** A meeting only spawns a wiki page if the user explicitly promotes the summary. The auto-distillation pipeline (BF-7) applies to brainstorms only. |
| BF-16 | **`meeting` is a distinct source class** in retrieval, ranked between `wiki` and `draft`. Default order becomes: `brainstorm > wiki > meeting > draft > project > raw > reference`. A new intent `'meeting-recall'` (or `'what-was-said'`) filters to meeting-only. |
| BF-17 | **Meeting audio retention is stricter than brainstorm audio.** Default purges meeting audio after 30 days unless explicitly kept. Configurable via `DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS` (default `30`). Brainstorm audio retains the existing `DEVNEURAL_AUDIO_MAX_AGE_DAYS=0` (forever) default. Reasoning: meetings contain third-party voices and the consent-to-record posture matters legally and ethically. |
| BF-18 | **Lex behaviour in meeting mode does not participate.** Listen, summarise, flag action items. The few-shot block at `07-daemon/data/lex-prompts/few-shot/meeting-notes.md` (LX-3) plus a meeting-specific refusal contract enforce this. |
| BF-19 | **Awareness broadcaster is fully silent in meeting mode.** No L1 ticks, no L2 push, period. Resumes only after the meeting session ends. **Enforcement is daemon-side, not prompt-side:** every awareness path (`recent_context()` tool, `POST /lex/recall`, L1 broadcaster ticks) checks `brainstorm_sessions.kind` for the active session and refuses with `403 Forbidden { reason: 'meeting_mode_silenced' }` when `kind='meeting'`. The refusal contract in the prompt is a defence-in-depth backstop, never the only guard. See section 4.1 (`recent_context()`), section 4.2 (`POST /lex/recall`), and Appendix R.2 #4. |

### 2.2 Curator and reinforcement instrumentation

| ID | Decision |
|---|---|
| CI-1 | Every curator decision (inject or silence) writes a row to `curator_log`. Schema in section 8.1. |
| CI-2 | Every detected hit and correction writes a row. Schema in section 8.1. |
| CI-3 | Click-throughs on injected page links record a click signal. Dashboard click handler posts to `/curator/click` (the canonical endpoint name; see section 4.1). |
| CI-4 | A "this looks wrong" button on every injection drops the page weight by a fixed delta and flags the page for self-audit. Endpoint in section 4.3. |
| CI-5 | A confidence score (0 to 1) is computed and stored on every injection record and surfaced inline next to the injected snippet. |
| CI-6 | A Curator Health KPI card on the dashboard shows: injections per day, hit rate, correction rate, silence rate, click-through rate, all over a rolling 7-day window. |
| CI-7 | A nightly synthetic canary fires a known prompt that should match a known page. Curator silence on the canary triggers a reminder. |
| CI-8 | A nightly schema regression suite runs Pass 2 against 50 pinned jsonl turns and asserts schema validity. Fails loud on drift. |

### 2.3 Wiki integrity and lifecycle

| ID | Decision |
|---|---|
| WI-1 | Every wiki page has a `schema_version` frontmatter field. Migration scripts live in `07-daemon/scripts/migrations/`. |
| WI-2 | A `frozen: true` frontmatter flag locks a page from LLM rewrite. Ingest reads the flag and skips the page. User edits to frozen pages are preserved across ingest. |
| WI-3 | Every page has a `last_verified` ISO timestamp. Lint flags pages where `now - last_verified > 90 days` for recheck. |
| WI-4 | Every wiki page has a `source_brainstorms: [<brainstorm_id>, ...]` frontmatter list when a brainstorm contributed. Surfaced in the page detail modal. |
| WI-5 | Pause mode freezes wiki decay (only) during configurable inactive windows. Brainstorms already exempt. |
| WI-6 | Lint promoted to a scheduled nightly job. Findings surface in dashboard with one-click "open page" links. |
| WI-7 | LLM self-audit periodic task runs in a fresh CC context: "are these 10 random pages still accurate, useful, well-scoped?" Findings to dashboard. |

### 2.4 Cross-project promotion

| ID | Decision |
|---|---|
| CP-1 | Promotion threshold raised to **N=3 distinct projects** AND a domain-distance check (project tags must differ on >=1 axis). Both required, not either. |
| CP-2 | Cross-project verifier remains in place but is now invoked only when both CP-1 conditions are met. |
| CP-3 | Pages whose `source_brainstorms` is non-empty are exempt from cross-project verifier outbound (per BF-4). |

### 2.5 Privacy boundary

| ID | Decision |
|---|---|
| PB-1 | `outbound.md` lives at repo root and lists every code path that sends data off-host. |
| PB-2 | `outbound_log` table records every outbound call. Schema in section 8.2. |
| PB-3 | Dashboard tile shows total outbound calls per day, per destination, with a configurable hard cap. Cap exceeded = ingest pauses outbound until next day. |
| PB-4 | Brainstorm content is forbidden in any outbound code path regardless of opt-in flags. Asserted by tests. |
| PB-5 | README is updated to drop "your data never leaves your machine" claim and replace with an accurate statement: "by default no data leaves your machine; opt-in flags allow Anthropic API for Pass 2 fallback and cross-project verification on non-brainstorm content only." |

### 2.6 Embedder and reindex

| ID | Decision |
|---|---|
| EM-1 | Every chunk row gets a `model_id` column. |
| EM-2 | `npm run reindex` walks all chunk tables and re-embeds in batches when the configured `model_id` does not match. |
| EM-3 | Mixed `model_id` values are tolerated transiently during reindex but vector queries fail open with a warning if a single query touches mixed model_ids. |

### 2.7 Test coverage

| ID | Decision |
|---|---|
| TC-1 | One golden-path integration test per layer: capture, ingest, query, reinforce, lint, curator, wiki, dashboard, voice, brainstorm. |
| TC-2 | Each integration test is hermetic: spins up a temp data root, fixture-loads sample inputs, runs the layer end-to-end, asserts output shape and content. |
| TC-3 | Cold-start test: register a brand-new project, ingest one fixture turn, assert the curator can inject a relevant cross-project page on the next prompt. |

### 2.8 Lex critical path

| ID | Decision |
|---|---|
| LX-1 | `SYSTEM_PROMPT_VERSION` increments per-prompt-change. The full prompt for each version is archived to `07-daemon/data/lex-prompts/<version>.md`. |
| LX-2 | A/B replay harness: `npm run lex-replay -- --input <fixture> --version-a <vA> --version-b <vB>` runs the same input against two prompt versions and produces a side-by-side diff. |
| LX-3 | Per-mode few-shot blocks live in `07-daemon/data/lex-prompts/few-shot/<mode>.md` and are concatenated into the system prompt at runtime by mode. Modes covered: `conversation`, `push-to-talk`, `notes` (which routes through the meeting-mode prompt per BF-18). |
| LX-4 | Refusal contract is a defined block in the system prompt with explicit dont-do-this examples. Meeting mode has its own refusal contract emphasising "do not interject; do not opine; capture and structure only." |
| LX-5 | Inline thumbs UI on every Lex turn (P2-3). Posts to `/lex/feedback` with `{ turn_id, vote: 'up'|'down', reason?: string }`. |
| LX-6 | Random artifact sampling: each day, surface 5 random recent artifacts in the dashboard for correct/incorrect labelling. Drives prompt-version dial tuning. |
| LX-7 | Awareness broadcaster (P2-2) ships only after CI-6 (Curator Health card) has been green for 7 consecutive days. Three-level model and inundation budget per Appendix R. |
| LX-8 | **Three-level context model for Lex.** L1 live awareness (5-15s tick, 200-token budget, diff-only after baseline), L2 recent context (5-10min push-on-change OR pull-by-tool, 600-token budget), L3 deep memory (`/lex/recall` on demand, 600-token budget). Total awareness overhead per Lex turn capped at ~1400 tokens. Fully specified in Appendix R. |
| LX-9 | **Lex learns through three independent loops.** Prompt loop (LX-1, LX-5, LX-6: months-scale prompt-version tuning via thumbs and labelled artifacts). Memory loop (BF-3: past Lex turns become brainstorm chunks; future Lex sessions recall via `/lex/recall`; days-scale). Behaviour loop (LX-3, LX-4: per-mode few-shot and refusal contracts; weeks-scale). The three feed each other: better prompts produce better artifacts, which become better recall material, which refines next prompts. |

### 2.9 Operational

| ID | Decision |
|---|---|
| OP-1 | External heartbeat: daemon POSTs `/heartbeat` to a tiny standalone Windows Service or a Tailscale-reachable phone shortcut every 60s. Phone alerts on no-beat in 10 minutes. |
| OP-2 | Native OS toast fallback when web push fails. Reuses notification hook plumbing. |
| OP-3 | GPU job queue: a single in-process queue serialises whisper.cpp and ollama jobs. VRAM monitor backs off ingest while voice is active. |
| OP-4 | Raw chunks cull rule: chunks older than 180 days with zero retrieval hits archive to cold storage outside the vector index. Brainstorm chunks exempt. |
| OP-5 | Quarterly restore drill: spin up a parallel daemon on backup data, sanity-check, document time-to-restore. Runbook at `docs/install/RESTORE-DRILL.md`. |
| OP-6 | Hybrid retrieval strategy is documented at `docs/spec/RETRIEVAL.md`: BM25 (FTS5) + vector cosine + recency boost + source-class weight, fused with a Reciprocal Rank Fusion or weighted-sum scorer (decision in section 4.2). |

---

## 3. Data model deltas

All schema changes follow this protocol:

1. **Migration runner integration (resolve in Q-1, do not skip):** before writing any migration, the agent identifies the existing migration runner. There must be exactly one. Three possibilities:
   - (a) Runner exists and SQL migrations live in a folder. Use it. Do not create a parallel system.
   - (b) Runner exists but only has TS-coded migrations. Extend the existing runner to also load `*.sql` files; do not create a separate SQL-only runner.
   - (c) No runner exists. Build a minimal one in `07-daemon/src/db/migrate.ts`: read `07-daemon/scripts/migrations/*.sql` in lex order, run each inside a transaction, record applied filenames in a `_migrations` table. The migrate function runs at daemon boot after env load and before HTTP bind.
2. **Migration numbering:** the spec uses placeholders (`001` through `009` for Wave 1 day 1, `P2-W1-D2-*` for day 2, etc.). On day 1, the agent picks a numbering scheme that matches the existing repo. If the existing repo uses `NNN-` prefixes, the agent computes the next available number and replaces the placeholders with concrete numbers in a single mechanical pass; this pass happens **before** any migration is run.
3. Each migration is idempotent and wrapped in a transaction.
4. Every new table has a `created_at` ISO timestamp default and an `id` primary key (TEXT UUID per Appendix C portability; **verify on day 1** that any divergence is intentional).
5. Every migration ships with a sibling `.down.sql` that reverses where safely possible; for forward-only migrations the down file is a comment stating "rollback via snapshot only" and `RAISE(ABORT, ...)`.

Sections below give the canonical schema. The migration SQL is the source of truth at runtime; this section documents intent.

### 3.1 `chunks` (existing): add columns

Tables affected: `raw_chunks`, `reference_chunks`, and any other chunk tables. **Verify on day 1**: enumerate all chunk tables in the current schema.

```
ALTER TABLE raw_chunks       ADD COLUMN model_id TEXT;
ALTER TABLE reference_chunks ADD COLUMN model_id TEXT;
-- backfill existing rows with the current configured embedder model id from settings
UPDATE raw_chunks       SET model_id = '<configured>' WHERE model_id IS NULL;
UPDATE reference_chunks SET model_id = '<configured>' WHERE model_id IS NULL;
```

A `CHECK (model_id IS NOT NULL)` constraint is added in a follow-up migration after backfill confirms zero NULLs.

### 3.2 `brainstorm_chunks` (new)

Stores turn-bounded full-transcript chunks. Mirrors `raw_chunks` shape but with a no-decay flag and source pointers.

```
CREATE TABLE brainstorm_chunks (
  id              TEXT PRIMARY KEY,
  brainstorm_id   TEXT NOT NULL,
  turn_index      INTEGER NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user','lex','tool')),
  mode            TEXT NOT NULL CHECK (mode IN ('conversation','notes','push-to-talk')),
  text            TEXT NOT NULL,
  embedding       BLOB,
  model_id        TEXT NOT NULL,
  no_decay        INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (brainstorm_id) REFERENCES brainstorm_sessions(id)
);
CREATE INDEX brainstorm_chunks_session ON brainstorm_chunks(brainstorm_id, turn_index);
CREATE INDEX brainstorm_chunks_mode    ON brainstorm_chunks(mode);
```

The session-end pipeline writes both:

- One `brainstorm-summary` row in `raw_chunks` (existing behaviour, retained).
- N `brainstorm_chunks` rows for the full transcript turn-bounded chunks (new).

### 3.3 `brainstorm_sessions` (existing): add columns

```
ALTER TABLE brainstorm_sessions ADD COLUMN project_slug   TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN audio_path     TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN distilled_at   TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN kind           TEXT NOT NULL DEFAULT 'brainstorm'
  CHECK (kind IN ('brainstorm','meeting'));
ALTER TABLE brainstorm_sessions ADD COLUMN attendees      TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN meeting_topic  TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN consent_acked  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brainstorm_sessions ADD COLUMN consent_acked_at TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN consent_acked_by TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN keep_audio     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE brainstorm_sessions ADD COLUMN provenance     TEXT NOT NULL DEFAULT 'voice'
  CHECK (provenance IN ('voice','audit-document','synthetic'));
```

Column meanings:

- `project_slug`: nullable; null = `general` namespace.
- `audio_path`: relative to data root; null if no audio. NEVER absolute (relocation safety).
- `distilled_at`: ISO timestamp of last distillation.
- `kind`: `brainstorm` (conversation + push-to-talk modes; solo ideation; first-class wiki distillation source) or `meeting` (notes mode; third-party voices; meeting-summary artifact only).
- `attendees`: JSON array of strings; null when `kind='brainstorm'`. The user fills this at session start or post-hoc.
- `meeting_topic`: short descriptor for the meeting; null when `kind='brainstorm'`.
- `consent_acked`: `1` when the user has confirmed every attendee was informed of the recording. `0` is the default. `kind='brainstorm'` ignores this column.
- `consent_acked_at`: ISO timestamp of the ack. Null until ack happens. Required for later privacy audits.
- `consent_acked_by`: actor who acked (the user account or 'cli'). Null until ack happens.
- `keep_audio`: `1` to override the `DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS` purge for this session. Default `0`. Only the user can set; the capture path never sets this implicitly.
- `provenance`: `voice` (the default; real captured speech), `audit-document` (synthetic session created by the audit-document ingest job per section 11 day 3 step 14), `synthetic` (any other non-voice synthetic source added in the future). Drives kind-rules and silence-rules independent of `mode`.

**Meeting capture / consent gate (executable rules):**

1. A session created with `kind='meeting'` starts in `consent_acked=0`. The capture rig MUST NOT write audio to disk until the user clicks the consent gate in `/meetings/[id]` or supplies `consent_acked=1` in the create payload (and `consent_acked_at` is set server-side, `consent_acked_by` from auth).
2. While `consent_acked=0`, transcription still runs in-memory but no `<session_id>.opus` or `.wav` is persisted; partial transcript chunks may persist (text only, no audio).
3. The `ConsentGate` component (section 5.2 entry) blocks the meeting detail UI behind the ack until done.
4. `keep_audio=1` only overrides retention age; it does NOT bypass the consent gate.
5. `kind='brainstorm'` sessions skip this gate entirely.

**`project_slug` was previously expected non-null.** **Verify on day 1**: check existing schema; if non-null, drop the constraint.

**Default kind based on mode at session creation:**

- `mode='conversation'` -> `kind='brainstorm'`.
- `mode='push-to-talk'` -> `kind='brainstorm'`.
- `mode='notes'` -> `kind='meeting'`.

The user can override at session creation via the `/sessions/new` form.

### 3.4 `wiki_drafts` (new)

Pending wiki drafts produced by automatic session-end distillation. Awaiting promote/edit/discard.

```
CREATE TABLE wiki_drafts (
  id              TEXT PRIMARY KEY,
  brainstorm_id   TEXT NOT NULL,  -- voice-session FK; column name retained for compatibility
                                  -- and accepts BOTH kind='brainstorm' AND kind='meeting' session ids
                                  -- (meetings only insert here on explicit POST /meetings/:id/promote-to-wiki)
  page_slug       TEXT NOT NULL,
  page_title      TEXT NOT NULL,
  body_markdown   TEXT NOT NULL,
  confidence      REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status          TEXT NOT NULL CHECK (status IN ('pending','promoted','discarded','auto-promoted','auto-dropped','superseded')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at     TEXT,
  resolved_by     TEXT,  -- 'user', 'auto-threshold', 'manual-discard'
  FOREIGN KEY (brainstorm_id) REFERENCES brainstorm_sessions(id)
);
CREATE INDEX wiki_drafts_status   ON wiki_drafts(status, created_at);
CREATE INDEX wiki_drafts_session  ON wiki_drafts(brainstorm_id);
```

Auto-drop runs as a daily scheduled job. Default: auto-drop at confidence < 0.30 after 14 days idle.

**Auto-promote is disabled in Wave 1.** The confidence formula in Appendix H is uncalibrated and rewards novelty; auto-promoting on it would pollute the wiki with plausible-but-wrong pages. Auto-promote is gated behind a feature flag (`DEVNEURAL_DRAFT_AUTO_PROMOTE_ENABLED=false`, default off) and stays off until Wave 3 logistic-regression calibration on labeled promote/discard history (Appendix H Wave 3 refinement). Until then, every promote requires an explicit user click in `/drafts` or `/brainstorms/:id`. Configurable via env vars (section 6).

### 3.5 `outbound_log` (new)

Every off-host call is logged. The privacy invariant is **provenance-based**, not class-based: a wiki page derived from any voice session (brainstorm or meeting) is just as forbidden off-host as the raw transcript itself.

```
CREATE TABLE outbound_log (
  id                              TEXT PRIMARY KEY,
  destination                     TEXT NOT NULL,
  purpose                         TEXT NOT NULL,
  payload_class                   TEXT NOT NULL,
  contains_voice_session_source   INTEGER NOT NULL DEFAULT 0,  -- 0 = false, 1 = true; covers brainstorms AND meetings
  payload_bytes                   INTEGER NOT NULL,
  request_at                      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  response_status                 INTEGER,
  response_at                     TEXT,
  error                           TEXT,
  failure_code                    TEXT
);
CREATE INDEX outbound_log_day ON outbound_log(request_at);
-- Enforce: no voice-session class AND no voice-session-derived provenance ever leave the host
CREATE TRIGGER outbound_no_voice_session
BEFORE INSERT ON outbound_log
FOR EACH ROW
WHEN (NEW.payload_class LIKE 'brainstorm-%')
   OR (NEW.payload_class LIKE 'meeting-%')
   OR (NEW.contains_voice_session_source = 1)
BEGIN
  SELECT RAISE(ABORT, 'voice-session content (brainstorm or meeting) or voice-session-derived content cannot be sent off-host (PB-4)');
END;
```

**Application-level enforcement (code side):**

1. Every outbound call site computes `contains_voice_session_source` for the payload by checking:
   - Is `payload_class` in the voice-session class set (`brainstorm-*` or `meeting-*`)? -> true.
   - Is the payload a wiki page whose `source_brainstorms` or `source_meetings` frontmatter is non-empty? -> true.
   - Is the payload derived from a `brainstorm_chunks` row (any kind)? -> true.
2. If `contains_voice_session_source` is true, the call is refused before the network attempt; the refusal is logged with `failure_code='voice-session-blocked'`.
3. Cross-project verifier (`07-daemon/src/ingest/cross-project.ts`) explicitly skips any candidate page whose `source_brainstorms` OR `source_meetings` is non-empty, even before reaching the outbound layer.
4. The DB trigger is the third line of defence.

### 3.6 `curator_log` (new)

Every curator decision recorded. Drives Curator Health card and the canary.

```
CREATE TABLE curator_log (
  id              TEXT PRIMARY KEY,
  prompt_id       TEXT NOT NULL UNIQUE, -- unique correlation key; allows curator_signal to reference by prompt_id via UNIQUE index OR by id via FK (we use id for FK, prompt_id for callers)
  session_id      TEXT,
  project_slug    TEXT,
  decision        TEXT NOT NULL CHECK (decision IN ('inject','silence')),
  page_slug       TEXT,                 -- null when decision = 'silence'
  score           REAL,                 -- vector / hybrid score
  threshold       REAL NOT NULL,
  confidence      REAL,                 -- 0..1, exposed inline next to injection
  source_class    TEXT,                 -- which class won the source-class re-rank
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX curator_log_day     ON curator_log(created_at);
CREATE UNIQUE INDEX curator_log_prompt_uq ON curator_log(prompt_id);
```

### 3.7 `curator_signal` (new)

Hits, corrections, and click-throughs that follow a curator decision.

```
CREATE TABLE curator_signal (
  id              TEXT PRIMARY KEY,
  curator_log_id  TEXT NOT NULL,
  prompt_id       TEXT NOT NULL,                  -- correlation token only, not a parent key
  signal          TEXT NOT NULL CHECK (signal IN ('hit','correction','click','wrong')),
  source          TEXT NOT NULL CHECK (source IN ('regex-inferred','user-explicit','dashboard-click')),
  weight          REAL NOT NULL DEFAULT 1.0,  -- 1.0 inferred, 10.0 explicit
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (curator_log_id) REFERENCES curator_log(id)
);
CREATE INDEX curator_signal_log     ON curator_signal(curator_log_id);
CREATE INDEX curator_signal_prompt  ON curator_signal(prompt_id);
```

Note: `curator_log.prompt_id` is also `UNIQUE` (per migration `006/curator-log` DDL above; the unique index lets external callers pass `prompt_id` as a correlation token while the FK uses `id` for SQLite-valid parent-key referencing).

### 3.8 Wiki page frontmatter (file-level, not SQL)

Frontmatter additions on every wiki page (markdown frontmatter, parsed by existing wiki loader; **verify on day 1** that the loader supports unknown fields gracefully):

```yaml
schema_version: 2
last_verified: null              # ISO date when the page was last verified accurate; null = never verified
frozen: false
source_brainstorms: []           # array of brainstorm_session ids (kind=brainstorm)
source_meetings: []              # array of brainstorm_session ids where kind=meeting
derived_from_brainstorm: false   # true if this page's primary evidence came from a brainstorm
derived_from_meeting: false      # true if this page's primary evidence came from a meeting (rare; explicit user promote)
```

A migration script sweeps every existing wiki page and adds defaults: `schema_version: 2`, `last_verified: null` (NOT now: `now` would destroy the staleness signal for 90 days), `frozen: false`, `source_brainstorms: []`, `source_meetings: []`, `derived_from_brainstorm: false`, `derived_from_meeting: false`. Lint treats `last_verified: null` as `verification_unknown` and flags pages for first-time verification on a separate, lower-severity track than the 90-day stale flag.

**Lineage KPI denominator (S-8) is brainstorm-only:** `wiki_lineage_coverage = COUNT(pages WHERE derived_from_brainstorm = true AND source_brainstorms != []) / COUNT(pages WHERE derived_from_brainstorm = true)`. Meeting-derived pages are excluded from the brainstorm lineage KPI because meetings rarely spawn wiki pages and the ratio would be misleading. Pages where `derived_from_brainstorm = false` are excluded from the denominator. This prevents the metric from incentivising fake lineage tagging on pages that never came from a brainstorm.

### 3.9 `meeting_action_items` (new)

Action items extracted from meeting summaries. Surfaced in `MeetingDetailResponse.action_items` and feed reminder creation. Persisted as a first-class table (not as JSON in a meeting summary blob) so dashboards, reminder system, and the random-artifact sampler can index over them.

```
CREATE TABLE meeting_action_items (
  id              TEXT PRIMARY KEY,
  meeting_id      TEXT NOT NULL,           -- voice-session FK with kind='meeting'
  text            TEXT NOT NULL,
  assignee        TEXT,                    -- attendee name string; nullable for un-assigned
  due             TEXT,                    -- ISO date or null
  reminder_id     TEXT,                    -- FK to reminders table when promoted to a reminder
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed','superseded')),
  source_turn_index INTEGER,               -- which turn the item came from; helps retraction on transcript edit
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at     TEXT,
  FOREIGN KEY (meeting_id) REFERENCES brainstorm_sessions(id)
);
CREATE INDEX meeting_action_items_meeting ON meeting_action_items(meeting_id);
CREATE INDEX meeting_action_items_status  ON meeting_action_items(status, due);
```

Migration filename: `013a-meeting-action-items.sql` (lands with the Wave 2 day 1 prerequisite block; renumber on the day-1 mechanical pass per Q-1).

### 3.10 Artifact kinds (canonical enum)

The artifact universe surfaced in `BrainstormDetailResponse.artifacts`, `MeetingDetailResponse.action_items` (for action items only), and the random-artifact sampler (LX-6) is:

| Kind | Source | Owning session kind | Random-sample participation |
|---|---|---|---|
| `research-note` | Pass 2 + manual | brainstorm | yes |
| `wiki-draft` | session-end auto-distillation | brainstorm | yes |
| `project-intent` | Pass 2 | brainstorm | yes |
| `notes-summary` | session-end pipeline | brainstorm (legacy notes mode pre-BF-14) | yes |
| `meeting-summary` | session-end pipeline | meeting | yes |
| `meeting-action-item` | meeting-summary extractor | meeting | yes (separate row in sampler) |
| `audit-finding` | lint, self-audit, canary, user-flag | not session-bound | no (handled by `LintFindingsPanel`) |

Adding a new artifact kind requires updating: section 3.10, the `artifacts.kind` enum in section 4.1 responses, the random-artifact sampler in section 11 day 5 step 25, and any retention rule in Appendix M.

---

## 4. API contracts

All endpoints are JSON over HTTP. Auth: existing PIN-cookie scheme (**verify on day 1**: confirm header / cookie name).

### 4.1 New endpoints

#### `GET /brainstorms`

Query params: `project=<slug|general>`, `mode=<conversation|notes|push-to-talk>`, `from=<ISO>`, `to=<ISO>`, `q=<text>`, `page=<n>`, `page_size=<n>`.

Response:

```ts
type BrainstormListResponse = {
  total: number;
  page: number;
  items: Array<{
    id: string;
    title: string;
    project_slug: string | null;       // null surfaces as "general"
    mode: 'conversation' | 'notes' | 'push-to-talk';
    started_at: string;                // ISO
    ended_at: string | null;
    duration_seconds: number | null;
    summary: string;                   // rolling summary text
    artifact_count: number;
    wiki_pages_spawned: number;
    has_audio: boolean;
  }>;
};
```

#### `GET /brainstorms/:id`

Response:

```ts
type BrainstormDetailResponse = {
  id: string;
  title: string;
  project_slug: string | null;
  mode: 'conversation' | 'notes' | 'push-to-talk';
  started_at: string;
  ended_at: string | null;
  summary: string;
  audio_url: string | null;            // /brainstorms/:id/audio
  transcript_chunks: Array<{
    turn_index: number;
    role: 'user' | 'lex' | 'tool';
    text: string;
    timestamp: string;
  }>;
  artifacts: Array<{
    id: string;
    kind: 'research-note' | 'wiki-draft' | 'project-intent' | 'notes-summary';
    body: string;
    created_at: string;
  }>;
  wiki_lineage: Array<{
    page_slug: string;
    page_title: string;
    promoted_from_draft_id: string | null;
  }>;
  pending_drafts: Array<{
    id: string;
    page_slug: string;
    page_title: string;
    confidence: number;
  }>;
};
```

#### `GET /brainstorms/:id/audio`

Streams the source audio bundle from `data/brainstorms/<id>/audio/`. Content-Type detected from extension. Range requests supported.

#### `POST /brainstorms/:id/redistill`

Admin-only. Forces re-execution of the session-end pipeline against the existing transcript.

Request body: `{}` (empty).

Response: `{ status: 'queued' | 'completed', new_drafts: string[] }`.

Note: only applies to sessions with `kind='brainstorm'`. Calling on a meeting returns `400 Bad Request` with `{ reason: 'wrong_kind', detail: 'use /meetings/:id/resummarise' }`.

#### `GET /meetings`

Query params: `project=<slug|general>`, `from=<ISO>`, `to=<ISO>`, `q=<text>`, `attendee=<name>`, `page`, `page_size`.

Response:

```ts
type MeetingListResponse = {
  total: number;
  page: number;
  items: Array<{
    id: string;
    meeting_topic: string | null;
    project_slug: string | null;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number | null;
    summary: string;
    attendees: string[];
    action_items_count: number;
    has_audio: boolean;
    consent_acked: boolean;
  }>;
};
```

#### `GET /meetings/:id`

Response:

```ts
type MeetingDetailResponse = {
  id: string;
  meeting_topic: string | null;
  project_slug: string | null;
  started_at: string;
  ended_at: string | null;
  attendees: string[];
  consent_acked: boolean;
  summary: string;
  audio_url: string | null;        // null if purged or never retained
  audio_purges_at: string | null;  // ISO date when audio will auto-purge
  transcript_chunks: Array<{
    turn_index: number;
    speaker: string | 'unknown';   // attendee name if mapped, else 'unknown'
    text: string;
    timestamp: string;
  }>;
  action_items: Array<{
    id: string;
    text: string;
    assignee: string | null;
    due: string | null;
    reminder_id: string | null;
  }>;
};
```

#### `POST /meetings/:id/resummarise`

Admin-only. Re-runs the meeting-summary pipeline (not Pass 2; meetings do not produce wiki drafts by default).

Request body: `{}`.

Response: `{ status: 'queued' | 'completed' }`.

#### `POST /meetings/:id/promote-to-wiki`

Explicit user action: turn this meeting into a wiki page candidate. Runs Pass 2 only on user request, produces a `wiki_drafts` row, sets `derived_from_meeting=true` and adds the meeting id to `source_meetings` on promotion. Default behaviour is to NOT auto-distill meetings.

Request body: `{}`.

Response: `{ draft_id: string, status: 'pending_review' }`.

#### `GET /meetings/:id/audio`

Same shape as `/brainstorms/:id/audio`. Returns 404 with `{ reason: 'audio_purged' }` after the meeting audio has been auto-purged per `DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS`.

#### `GET /drafts`

Query params: `status=<pending|all>`, `page`, `page_size`.

Response:

```ts
type DraftListResponse = {
  total: number;
  page: number;
  items: Array<{
    id: string;
    brainstorm_id: string;
    brainstorm_title: string;
    page_slug: string;
    page_title: string;
    confidence: number;
    status: 'pending' | 'promoted' | 'discarded' | 'auto-promoted' | 'auto-dropped';
    created_at: string;
  }>;
};
```

#### `POST /drafts/:id/promote`

Promotes a draft to a real wiki page. Writes the page to `wiki/`, sets the draft `status='promoted'`, populates `source_brainstorms` and `derived_from_brainstorm: true` on the new page.

Request body:

```ts
{
  edits?: { title?: string; body_markdown?: string };
  on_conflict?: 'fail' | 'merge-suggest' | 'overwrite-with-version';  // default 'fail'
  expected_target_version?: string;     // optional optimistic-concurrency token
}
```

**Conflict semantics (must implement, all four cases):**

1. **Slug collision (target page exists):** default behaviour is fail-closed. Response: `409 Conflict` with body `{ reason: 'slug_collision', target_slug, target_last_modified, suggestion: 'try slug-2 or use on_conflict=merge-suggest' }`. With `on_conflict='merge-suggest'`, the daemon writes the draft body to a new file `wiki/<slug>.merge-suggested-<draft_id>.md` and returns 202 with that path. Never silently overwrites.
2. **Target is `frozen: true`:** absolute refusal regardless of `on_conflict`. Response: `409 Conflict` `{ reason: 'target_frozen', target_slug }`. The user must unfreeze first or write to a new slug.
3. **Two drafts targeting the same slug (race):** the first promote that lands wins. The second's promote returns `409 Conflict` with `{ reason: 'superseded', target_slug, winning_draft_id }`, and the second draft's `status` is set to `superseded` automatically. Resolution: the user can edit the second draft's slug and re-submit, or discard.
4. **Target page changed since draft was created (drift):** if `expected_target_version` is supplied and does not match the current page's hash, return `409 Conflict` `{ reason: 'target_drifted', current_version_hash, draft_version_hash }`. With `on_conflict='overwrite-with-version'` plus a matching `expected_target_version`, the promote proceeds. Without it, fail.

Response (success): `{ page_slug: string, status: 'promoted', target_version_hash: string }`.

#### `POST /drafts/:id/discard`

Sets the draft `status='discarded'`.

Request body: `{}`.

Response: `{ status: 'discarded' }`.

#### `POST /curator/wrong`

Inline "this looks wrong" button. Drops the page weight by a fixed delta and flags for self-audit.

Request body: `{ prompt_id: string, page_slug: string, reason?: string }`.

Response: `{ new_weight: number, flagged: boolean }`.

#### `POST /curator/click`

Records a dashboard click-through on an injected page link.

Request body: `{ prompt_id: string, page_slug: string }`.

Response: `{ recorded: true }`.

#### `POST /lex/feedback`

Inline thumbs UI on Lex turns.

Request body:

```ts
{
  turn_id: string;
  vote: 'up' | 'down';
  reason?: string;
  prompt_version: string;
}
```

Response: `{ recorded: true }`.

#### `GET /stats/curator-health`

Drives the Curator Health KPI card. Window default: last 7 days.

Response:

```ts
{
  window_days: number;
  injections_per_day: number[];        // length = window_days
  hit_rate: number;                    // 0..1
  correction_rate: number;
  silence_rate: number;
  click_through_rate: number;
  canary_status: 'green' | 'red' | 'unknown';
  canary_last_run: string | null;
  flagged_pages_count: number;
}
```

#### `GET /stats/brainstorm-kpi`

Drives the brainstorm KPI tiles.

Response:

```ts
{
  total_brainstorms: number;
  hours_captured: number;
  artifacts_per_brainstorm_avg: number;
  wiki_lineage_coverage: number;       // fraction of wiki pages with non-empty source_brainstorms
  project_less_ratio: number;          // fraction of brainstorms with project_slug = null
  active_today: number;
}
```

#### `GET /stats/outbound`

Drives the outbound dashboard tile.

Response:

```ts
{
  today: {
    calls_total: number;
    calls_by_destination: Record<string, number>;
    bytes_total: number;
    cap: number;
    cap_remaining: number;
    paused: boolean;
  };
  last_7_days: Array<{ date: string; calls: number; bytes: number }>;
  brainstorm_outbound_count_alltime: 0;   // always zero by contract
}
```

#### `POST /heartbeat`

External-heartbeat target on a separate process or a Tailscale phone shortcut. Daemon POSTs every 60s.

Request body: `{ ts: string, daemon_pid: number, version: string }`.

Response: `{ acked: true }`.

(This endpoint lives outside the daemon, on the heartbeat watcher; section 11 covers the watcher service.)

#### `POST /sessions/new` (canonical voice-session create contract)

Creates either a brainstorm or a meeting voice-session row. This is the single canonical entry point for both kinds; UI, CLI, and PTY-spawn paths all funnel through it. Replaces any earlier per-kind endpoints.

Request body:

```ts
{
  mode: 'conversation' | 'notes' | 'push-to-talk';
  kind?: 'brainstorm' | 'meeting';   // if omitted: derived from mode per BF-14
                                     // (conversation -> brainstorm; push-to-talk -> brainstorm; notes -> meeting)
  project_slug?: string | null;      // null = general namespace
  title?: string;                    // brainstorm title; ignored when kind='meeting'
  meeting_topic?: string;            // required when kind='meeting'
  attendees?: string[];              // required when kind='meeting'; non-empty
  consent_acked?: boolean;           // when kind='meeting': true unlocks audio capture immediately
                                     // false (or omitted) creates the session in pre-consent state
                                     // (see section 3.3 meeting capture / consent gate rules)
  keep_audio?: boolean;              // when kind='meeting': overrides DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS
                                     // ignored for brainstorm (always retained per DEVNEURAL_AUDIO_MAX_AGE_DAYS)
}
```

Server-side validation:

- `kind='meeting'` requires `meeting_topic` and `attendees.length >= 1`. Otherwise `400 Bad Request { reason: 'meeting_requires_topic_and_attendees' }`.
- `kind='meeting'` with `consent_acked=true` records `consent_acked_at = now()` and `consent_acked_by = <auth subject>`.
- A `notes`-mode session with explicit `kind='brainstorm'` is allowed (override for solo voice-notes flows). It records a low-severity `audit_findings` row with `source='user-flag'` so the user can see the override later in case it was wrong (see review-002 risk E3 mitigation).
- The capture rig consults `kind`, `consent_acked`, and `keep_audio` before writing audio.

Response:

```ts
{
  id: string;
  kind: 'brainstorm' | 'meeting';
  capture_state: 'capturing' | 'awaiting_consent' | 'pre_capture';
}
```

#### `POST /sessions/:id/consent`

Acknowledges meeting consent post-create. Required when the session was created with `consent_acked=false` and the user wants audio retention to begin.

Request body: `{ consent_acked: true }`.

Response: `{ id, capture_state: 'capturing', consent_acked_at: string, consent_acked_by: string }`.

Refuses (`400 Bad Request { reason: 'wrong_kind' }`) when called on a `kind='brainstorm'` session.

### 4.2 Modified endpoints

#### `POST /lex/recall` (existing, modified)

New optional fields:

- `session_id`: voice-session id of the calling Lex turn. **Required when called from a Lex tool path** (so the daemon can enforce meeting-mode silence per BF-19); permitted to be omitted for non-Lex callers (admin tools, dashboard search). When provided, the daemon looks up `brainstorm_sessions.kind` and refuses with `403 Forbidden { reason: 'meeting_mode_silenced' }` if `kind='meeting'`. When omitted, the call proceeds without the gate; this path is gated behind admin auth.
- `intent`: `'default' | 'brainstorm-only' | 'what-was-i-thinking' | 'meeting-recall'`. Default `'default'`.
- `source_class_weights`: optional override `{ brainstorm: number; wiki: number; meeting: number; draft: number; project: number; raw: number; reference: number }`. If omitted, server uses defaults.

Default source-class weights (BF-1, BF-16):

```ts
const DEFAULT_SOURCE_CLASS_WEIGHTS = {
  brainstorm: 1.20,
  wiki:       1.00,
  meeting:    0.90,   // BF-16: between wiki and draft; reference-style record
  draft:      0.85,
  project:    0.70,
  raw:        0.50,
  reference:  0.30,
};
```

Hybrid retrieval scorer (OP-6): final score per candidate = `bm25_normalized * w_bm25 + cosine * w_cos + recency_boost * w_rec` then multiplied by `source_class_weight`. Default `w_bm25=0.30, w_cos=0.55, w_rec=0.15`. Recency boost: `exp(-age_days / 30)`.

Intent overrides:

- `'brainstorm-only'`: filter to brainstorm sources only before scoring.
- `'what-was-i-thinking'`: increase `brainstorm` weight to 2.0, decrease `wiki` to 0.5; also bias toward older sessions with a **bounded** older-is-better prior. Replace the recency term with `older_boost = min(1 + (age_days / 90), 3.0)`. Cap at 3.0 prevents a 5-year-old session from drowning a semantically perfect recent match. Implementations MUST clamp; an unbounded `exp(+age_days/90)` is forbidden because it can swamp cosine.
- `'meeting-recall'` (BF-16): filter to `kind='meeting'` source class only; default recency boost retained (meetings are reference-style and recent meetings are usually what's wanted, unless the user opts otherwise).

#### `GET /sessions/:id` (existing, additive)

Add fields: `pending_prompt`, `injected_pages: Array<{ page_slug, score, confidence, prompt_id }>`. **Verify on day 1**: confirm field naming convention.

### 4.3 Lex tool contracts

Tools exposed to Lex via the existing tool-spawn mechanism. Tool contracts mirror HTTP endpoints but carry the active `session_id` automatically (the Lex runtime injects it from the spawn context); the daemon enforces the same kind-gate as the corresponding HTTP path.

#### `recent_context()`

Lex's L2 pull-by-default tool (Appendix R.1). Returns user-actionable recent state.

Tool input schema:

```ts
{
  since?: string;                    // ISO timestamp; default = "now - 24h"
  categories?: Array<                // closed enum; default = all enabled categories per per-mode rules
    'audit_findings' |
    'reminders_due' |
    'drafts_dropped' |
    'canary_failures' |
    'outbound_cap_hits' |
    'heartbeat_missed' |
    'thumbs_down_recent'
  >;
}
```

Tool output schema:

```ts
{
  items: Array<{
    category: string;                // matches the categories enum above
    summary: string;                 // 1-2 sentence summary; per-item budget enforced
    detail_url?: string;             // dashboard deep-link
    severity?: 'low' | 'medium' | 'high';
    occurred_at: string;             // ISO
  }>;
  truncated: boolean;                // true if budget forced summarisation
  total_token_estimate: number;      // pre-summarisation
}
```

Daemon-side rules:

1. **Meeting silence:** if the active `session_id` resolves to `kind='meeting'`, the tool returns `{ items: [], truncated: false, total_token_estimate: 0, refused: 'meeting_mode_silenced' }`. The Lex runtime treats `refused` as a signal to drop the tool from the available-tools list for the remainder of the meeting session.
2. **Per-mode verbosity (Appendix R.2 #4):** in `push-to-talk` brainstorm sessions the tool is available but `categories` is filtered to `['reminders_due']` only.
3. **Token budget:** tool output is capped at `DEVNEURAL_LEX_AWARENESS_L2_TOKEN_CAP` (default 600). Over-budget items are summarised by the same fast-path local LLM (`qwen3:8b`) used by the L1 broadcaster, with the load-shedding rule from Appendix R.2 #1a.

#### `lex_recall()`

Thin wrapper over `POST /lex/recall`. Always passes the active `session_id`. Same meeting-silence behaviour as `recent_context()`.

---

## 5. UI components and routes

Stack assumptions (**verify on day 1**): Next.js 15 App Router, Tailwind v4, Tanstack Query, Tremor for charts.

### 5.1 New routes

| Route | Component file | Purpose |
|---|---|---|
| `/brainstorms` | `08-dashboard/app/brainstorms/page.tsx` | List of all brainstorm sessions (`kind='brainstorm'` only) with filters and search. |
| `/brainstorms/[id]` | `08-dashboard/app/brainstorms/[id]/page.tsx` | Brainstorm detail page with summary, transcript, audio player, artifacts, lineage, pending drafts. |
| `/meetings` | `08-dashboard/app/meetings/page.tsx` | List of meeting sessions (`kind='meeting'`) with attendee filter, date range, project link. |
| `/meetings/[id]` | `08-dashboard/app/meetings/[id]/page.tsx` | Meeting detail page with summary, transcript (with speaker mapping), audio (if not purged), action items, consent state, promote-to-wiki action. |
| `/drafts` | `08-dashboard/app/drafts/page.tsx` | Pending wiki drafts queue with promote/edit/discard actions. |

### 5.2 New components

| Component | File | Notes |
|---|---|---|
| `BrainstormList` | `08-dashboard/components/BrainstormList.tsx` | Table view; filter chips for project, mode, date range; search box. |
| `BrainstormDetail` | `08-dashboard/components/BrainstormDetail.tsx` | Wraps summary, transcript, artifacts, audio, lineage. |
| `AudioPlayer` | `08-dashboard/components/AudioPlayer.tsx` | HTML5 audio with playback rate control. Default rate 0.9 per user memory `voice_playback_speed.md`. |
| `DraftsQueue` | `08-dashboard/components/DraftsQueue.tsx` | List of pending drafts with inline promote/discard buttons. |
| `DraftEditor` | `08-dashboard/components/DraftEditor.tsx` | Modal with markdown edit + preview; promote action submits edits. |
| `CuratorHealthCard` | `08-dashboard/components/kpi/CuratorHealthCard.tsx` | Sparkline of injections/day plus rates and canary status indicator. |
| `BrainstormKpiTiles` | `08-dashboard/components/kpi/BrainstormKpiTiles.tsx` | Five tiles: total, hours, avg artifacts, lineage coverage, project-less ratio. |
| `OutboundCard` | `08-dashboard/components/kpi/OutboundCard.tsx` | Today's calls, by destination, cap-remaining bar, brainstorm-outbound-count (always 0 by contract; renders "0 ever, by design"). |
| `InjectionRow` | `08-dashboard/components/sessions/InjectionRow.tsx` | Shows an injected page with confidence pill, "this looks wrong" button. Used in SessionDetail. |
| `LexThumbs` | `08-dashboard/components/sessions/LexThumbs.tsx` | Inline thumbs on each Lex turn. |

### 5.3 Modified routes and components

- `08-dashboard/app/page.tsx` (home): inject `BrainstormKpiTiles`, `CuratorHealthCard`, `OutboundCard` into the existing KPI strip.
- `08-dashboard/app/sessions/[id]/page.tsx`: add `InjectionRow` rendering for any injected pages on this prompt; add `LexThumbs` per Lex turn.
- `08-dashboard/components/Orb.tsx` (existing): unify graph data source. New endpoint `/graph/unified` (covered in Wave 3) returns `{ nodes: Array<{ id, type: 'brainstorm'|'wiki'|'project', title, weight }>, edges: Array<{ source, target, kind }> }`. Filter chips replace prior layer toggles.
- `08-dashboard/app/sessions/page.tsx` (existing): add a chip filter "include brainstorms" but keep this route as the *session* list; brainstorms get their own top-level route per BF-5.

### 5.4 Navigation

Top-level navigation order (left to right or top to bottom in mobile drawer):

1. Home
2. Brainstorms (new)
3. Meetings (new)
4. Sessions
5. Wiki
6. Drafts (new)
7. Projects
8. Reminders
9. System
10. Orb

### 5.5 Form-factor preservation (mandatory)

Phase Two ADDS to the dashboard; it does not replace the existing layout. The current home strip, sparklines, panels, and component vocabulary stay. Specifically preserved:

- **Stream Deck rail** (existing component, grouped by project; manual refresh button below "new session"). New brainstorm and meeting routes do NOT remove the rail.
- **Projects route and project-detail pages** (existing). New brainstorm/meeting linkage adds a "Recent voice sessions" panel inside the project detail page; does not relocate Projects.
- **Sessions route** (existing CC-session list) stays. Filter chips inside it now include "show brainstorms" and "show meetings" but the route remains the worker-CC-session feed.
- **Reminders, System, Orb routes** unchanged in role; Wave 3 enhances Orb but the route stays.
- **Home KPI strip** retains existing tiles (Size, Quality, Activity, Velocity, Health). Wave 1 adds Curator Health, Brainstorm KPI tiles, and Outbound tiles into the strip; the strip layout stays five-row, the new tiles slot into the matching row (Quality for Curator Health, Activity for Brainstorm KPIs, Health for Outbound).
- **PIN auth, mobile responsive, PWA install** all unchanged.
- **Tone, color palette, typography** unchanged.
- **Conversational side (in-session prompt panel, pending-prompt UI, injected-page rendering)** retained and enhanced. Confidence pills and "this looks wrong" buttons (CI-4, CI-5) attach to the existing injection rendering; do not replace it.
- **Daily brief and what's-new rendering** existing routes retained.

If a Wave 1, 2, or 3 step would require removing or radically replacing an existing dashboard component, the agent must stop and ask. Augmentation is mandatory; replacement is the user's call.

### 5.6 Empty states

Every new route renders a constructive empty state: "no brainstorms yet, start one with the new-session button" with a link to `/sessions/new` plus the keyboard shortcut. The meetings route empty state notes the consent-acked requirement before audio retention starts.

### 5.7 Mobile and PWA

All new routes follow the existing mobile responsive grid (12-col desktop, single-col mobile) and use the existing PWA install path. Audio player honours iOS playback restrictions (user-gesture required to start). **Verify on day 1**: confirm SW caching strategy for audio (no cache; range requests).

---

## 6. Configuration and environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DEVNEURAL_DECAY_INTERVAL_MS` | `86400000` | Existing. Wiki decay only after BF-2. |
| `DEVNEURAL_PASS2_FALLBACK` | `disabled` | Existing. Forbidden for brainstorm content (BF-4). |
| `DEVNEURAL_OUTBOUND_DAILY_CAP_CALLS` | `200` | New. Hard cap on outbound calls per day. |
| `DEVNEURAL_OUTBOUND_DAILY_CAP_BYTES` | `5242880` | New. 5 MiB. |
| `DEVNEURAL_DRAFT_AUTO_PROMOTE_ENABLED` | `false` | New. Off in Wave 1. Gates the auto-promote daily job. |
| `DEVNEURAL_DRAFT_AUTO_PROMOTE_THRESHOLD` | `0.85` | New. Used only when ENABLED=true. |
| `DEVNEURAL_DRAFT_AUTO_DROP_THRESHOLD` | `0.30` | New. Confidence below auto-drops after idle window. |
| `DEVNEURAL_DRAFT_AUTO_PROMOTE_IDLE_DAYS` | `7` | New. |
| `DEVNEURAL_DRAFT_AUTO_DROP_IDLE_DAYS` | `14` | New. |
| `DEVNEURAL_PAUSE_MODE` | `auto` | New. `auto` infers inactivity from session activity; `on` forces freeze; `off` disables. |
| `DEVNEURAL_PAUSE_INACTIVITY_DAYS` | `21` | New. After this many days of zero activity, decay freezes automatically. |
| `DEVNEURAL_HEARTBEAT_URL` | unset | New. POST target for OP-1. Empty disables external heartbeat. |
| `DEVNEURAL_HEARTBEAT_INTERVAL_MS` | `60000` | New. |
| `DEVNEURAL_AUDIO_MAX_AGE_DAYS` | `0` | New. Brainstorm audio. 0 disables age-based deletion (default: keep forever). |
| `DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS` | `30` | New. Meeting audio default-purges after 30 days. Override per-session by setting `keep_audio` flag at promote time. |
| `DEVNEURAL_AUDIO_COMPRESSION` | `none` | New. `opus` re-encodes after N days. |
| `DEVNEURAL_LEX_AWARENESS_INTERVAL_MS` | `10000` | New. L1 broadcaster tick. |
| `DEVNEURAL_LEX_AWARENESS_L1_TOKEN_CAP` | `200` | New. Per-tick L1 token budget. |
| `DEVNEURAL_LEX_AWARENESS_L2_TOKEN_CAP` | `600` | New. Per-push L2 token budget. |
| `DEVNEURAL_LEX_AWARENESS_BACKPRESSURE_RATIO` | `0.40` | New. Awareness/turn token ratio above which the broadcaster downshifts. |
| `DEVNEURAL_LEX_PROMPT_VERSION` | latest | New. Pinned in case of regressions. |
| `DEVNEURAL_RAW_CHUNK_CULL_AGE_DAYS` | `180` | New. OP-4. |
| `DEVNEURAL_CROSSPROJECT_FALLBACK_NO_TAGS` | `block` | New. CP-1 fallback when participating projects lack tags. Values: `block`, `permissive`, `pause`. |

---

## 7. Privacy boundary (outbound document)

`outbound.md` lives at repo root. Template:

```markdown
# DevNeural Outbound

This file lists every code path that sends data off-host. Brainstorm content is forbidden everywhere.

## Code paths

| Path | Destination | Purpose | Data class | Trigger | Opt-in flag |
|---|---|---|---|---|---|
| `07-daemon/src/ingest/pass2.ts` `runPass2()` -> Anthropic fallback | api.anthropic.com (Haiku) | Pass 2 schema retry when local model fails | wiki page candidates from project transcripts and reference docs | local model exhausts retries | `DEVNEURAL_PASS2_FALLBACK=anthropic` |
| `07-daemon/src/ingest/cross-project.ts` `verifyMerge()` | api.anthropic.com (Haiku) | Cross-project pattern verification | wiki page candidate text plus the existing page text | first 2nd-project merge attempt and N=3 + domain-distance pass | always on when CP path triggers |
| `07-daemon/src/heartbeat/poster.ts` `postHeartbeat()` | configured `DEVNEURAL_HEARTBEAT_URL` | External liveness signal | daemon pid, version, ISO timestamp only | every 60s | `DEVNEURAL_HEARTBEAT_URL` set |

## Forbidden classes

Brainstorm content (`brainstorm-summary`, `brainstorm-transcript`, anything tagged `mode:notes|conversation|push-to-talk`, anything from `brainstorm_chunks`) is forbidden in every outbound path. Enforced by:

1. Application-level check in every outbound function (refuse to call API if payload class starts with `brainstorm-`).
2. Database trigger on `outbound_log` that aborts insert when payload_class matches `brainstorm-%`.

## Audit

Every outbound call writes a row to `outbound_log`. The dashboard `OutboundCard` shows totals per day and asserts the brainstorm-outbound-count is always zero.
```

---

## 8. Telemetry and observability schemas

### 8.1 Curator log fields (recap from 3.6 and 3.7)

`curator_log` and `curator_signal` together support computing:

- Injections per day = COUNT WHERE decision='inject' GROUP BY day.
- Silences per day = COUNT WHERE decision='silence' GROUP BY day.
- Hit rate = COUNT signals WHERE signal='hit' / COUNT inject decisions.
- Correction rate = COUNT signals WHERE signal IN ('correction','wrong') / COUNT inject decisions.
- Click-through rate = COUNT signals WHERE signal='click' / COUNT inject decisions.
- Canary status = boolean from latest canary run.

### 8.2 Outbound log fields (recap from 3.5)

`outbound_log` supports computing daily totals by destination and class. The `OutboundCard` queries `/stats/outbound` which aggregates over the last 7 days.

### 8.3 Lex feedback storage

```
CREATE TABLE lex_feedback (
  id              TEXT PRIMARY KEY,
  turn_id         TEXT NOT NULL,
  brainstorm_id   TEXT,
  prompt_version  TEXT NOT NULL,
  vote            TEXT NOT NULL CHECK (vote IN ('up','down')),
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX lex_feedback_version ON lex_feedback(prompt_version);
```

Aggregation query for "worst-rated turns this week":

```
SELECT turn_id, COUNT(*) as down_count
FROM lex_feedback
WHERE vote='down' AND created_at > datetime('now','-7 days')
GROUP BY turn_id
ORDER BY down_count DESC
LIMIT 20;
```

---

## 9. Test plan

### 9.1 Integration test layout

`07-daemon/tests/integration/` (new directory). One file per layer:

- `capture.int.test.ts`
- `ingest.int.test.ts`
- `query.int.test.ts`
- `reinforce.int.test.ts`
- `lint.int.test.ts`
- `curator.int.test.ts`
- `wiki.int.test.ts`
- `dashboard.int.test.ts`
- `voice.int.test.ts`
- `brainstorm.int.test.ts`

Each test:

1. Boots a daemon against a temp data root.
2. Loads fixture inputs from `07-daemon/tests/fixtures/<layer>/`.
3. Drives the layer end-to-end via the public API (HTTP).
4. Asserts output shape and key content.
5. Tears down the temp root.

### 9.2 Cold-start test

`07-daemon/tests/integration/cold-start.int.test.ts`. Registers a brand-new project, ingests one fixture turn, asserts `/lex/recall` returns at least one cross-project page candidate from a pre-seeded fixture wiki.

### 9.3 Brainstorm-first assertions

`brainstorm.int.test.ts` covers:

- BF-1: source-class weights enforced; brainstorm rows outrank wiki rows for the same query.
- BF-2: decay scheduler advances time; brainstorm chunks unchanged.
- BF-3: full transcript retrievable post session-end.
- BF-4: attempting to send brainstorm content to outbound throws and writes no outbound row.
- BF-7: session end writes pending drafts with confidence scores; no manual trigger.

### 9.4 Privacy regression test

`07-daemon/tests/security/outbound-brainstorm-forbidden.test.ts`: directly attempts to insert into `outbound_log` with `payload_class='brainstorm-summary'`. Asserts SQL trigger aborts and application-level check refuses.

### 9.5 Schema regression suite

`07-daemon/tests/schema-regression/` houses 50 pinned jsonl fixtures plus expected Pass 2 outputs (JSON files). A nightly task runs each fixture through Pass 2 and diffs the output against the expected file. Any structural diff (missing required fields, type mismatches) fails. Free-form text diffs flag a warning but do not fail.

**Fixture generation procedure (do not skip; agents must follow this exactly):**

1. Sample selection: query `raw_chunks` for 50 chunks across the existing project distribution. Use stratified sampling: 10 chunks per project from the top 5 projects by chunk count. If fewer than 5 projects exist, fall back to top-N evenly.
2. Each fixture file: `07-daemon/tests/schema-regression/fixtures/<NN>-<slug>.jsonl` where `<NN>` is 01..50 and `<slug>` is a short descriptor.
3. For each fixture, run Pass 2 *manually* once with the user reviewing the output; on user approval, save the validated output to `07-daemon/tests/schema-regression/expected/<NN>-<slug>.json`.
4. The "validated baseline" commit is the point at which the schema regression suite goes live; before that, it runs in advisory mode and only logs diffs.
5. Each fixture file is immutable once committed. Adding a new fixture is a new `<NN>-<slug>.jsonl` file with a higher number; existing fixtures and their expected outputs are never edited (otherwise drift becomes invisible).
6. Failing tests block CI. Schema validity diffs fail; free-text diffs warn. Both produce a structured diff report at `07-daemon/tests/schema-regression/last-run-report.json`.

Wave 1 day 3 ships the runner + 5 seed fixtures (smaller starter set, advisory only). The full 50 fixtures land in Wave 2 Track A as the user manually reviews outputs over a few sessions; the regression goes from advisory to enforcing once 50 are in place.

### 9.6 Synthetic canary

`07-daemon/scripts/canary.ts`: nightly task. Executes a known prompt against a known seeded page, asserts curator injects within threshold. Failure writes a reminder row and a row to `curator_log` with `decision='silence'` (so the canary failure is visible in Curator Health).

**Canary fixture generation procedure:**

1. Pick (or write) one wiki page that the curator should reliably match for a specific test prompt. Recommended seed page: the existing `connection-pooling.md` (or any well-formed page in the current wiki) paired with the canary prompt: `"explain database connection pooling and when it backfires under heavy concurrent writes"`.
2. The pair lives at `07-daemon/scripts/canary-fixture.json`: `{ "prompt": "...", "expected_page_slug": "connection-pooling", "minimum_score": 0.65 }`.
3. The canary script POSTs the prompt to the curator pipeline through the same code path a real `UserPromptSubmit` would, asserts the resulting `curator_log` row has `decision='inject'`, `page_slug == expected_page_slug`, and `score >= minimum_score`.
4. If any assertion fails, the canary writes:
   - A reminder row with severity `high` and message `"canary failed: <reason>"`.
   - A row to `curator_log` with `decision='silence'`, `page_slug=NULL`, `confidence=0`, `source_class='canary-fail'` so the silent-failure-mode telemetry visibly registers the failure.
5. Canary fixture is immutable once committed. To change the canary, write a second fixture; do not edit the first.

---

## 10. Wave 1 execution

Effort: ~3 days. Order is sequential within Wave 1 (later steps depend on earlier).

### Day 1: foundation

1. **Pre-flight backup.** `npm run backup`. Confirm latest snapshot in OneDrive folder.
2. **Migrations directory.** Create `07-daemon/scripts/migrations/` if missing. **Verify on day 1**: list any existing migration runner; if absent, build a minimal one in `07-daemon/src/db/migrate.ts` (read SQL files alphabetically, run inside a transaction, record applied migrations in a `_migrations` table).
3. **Schema versioning infrastructure (WI-1).** Migration `001-schema-version-meta.sql` creates `_migrations` and `wiki_meta` tables.
4. **Embedder model_id (EM-1).** Migration `002-add-model-id.sql` adds `model_id` to chunk tables and backfills.
5. **Brainstorm chunks table (BF-3).** Migration `003-brainstorm-chunks.sql`.
6. **Brainstorm sessions schema deltas (BF-6, BF-11, BF-14, BF-17).** Migration `004-brainstorm-sessions-deltas.sql`. Drops `project_slug NOT NULL` if present, adds `audio_path`, `distilled_at`, `kind`, `attendees`, `meeting_topic`, `consent_acked`, `consent_acked_at`, `consent_acked_by`, `keep_audio`, `provenance` (full DDL in section 3.3). Meeting code paths do not light up until Wave 2 day 5, but the columns ship now to keep migration ordering clean.
7. **Wiki drafts table (BF-7).** Migration `005-wiki-drafts.sql`.
8. **Outbound log + trigger (PB-2, BF-4).** Migration `006-outbound-log.sql`.
9. **Curator log and signal tables (CI-1, CI-2).** Migration `007-curator-log.sql`.
10. **Lex feedback (LX-5).** Migration `008-lex-feedback.sql`.
11. **Wiki frontmatter sweep (WI-1, WI-2, WI-3, WI-4).** Script `07-daemon/scripts/migrations/009-wiki-frontmatter-sweep.ts` walks `wiki/`, parses frontmatter, adds defaults if missing.
12. **Run migrations end-to-end** against a copy of the data root in a temp location. Verify schema and frontmatter on the copy. Promote to live data root only after the copy validates.

Day 1 commit checkpoint: `chore(db): phase two migrations 001-009`.

### Day 2: code wiring

13. **Source-classed retrieval reweight (BF-1).** Edit `07-daemon/src/lex/recall.ts` to apply `DEFAULT_SOURCE_CLASS_WEIGHTS` and accept overrides from request body. Add hybrid scorer per OP-6.
14. **Decay scope tighten (BF-2).** Edit `07-daemon/src/reinforcement/decay.ts` to filter `WHERE no_decay = 0` (covers `brainstorm_chunks`) and to skip wiki pages whose `frozen=true`.
15. **Outbound rule + log (PB-2, BF-4).** Edit `07-daemon/src/ingest/pass2.ts` and `07-daemon/src/ingest/cross-project.ts` to:
    - Reject payload class starting with `brainstorm-`.
    - Write `outbound_log` rows around every API call.
    - Honour `DEVNEURAL_OUTBOUND_DAILY_CAP_*`; on cap exceed, refuse and log.
16. **Cross-project threshold (CP-1).** Edit `07-daemon/src/ingest/cross-project.ts`: require N>=3 distinct projects AND a domain-distance check before invoking the verifier. Document the domain-distance formula in `docs/spec/RETRIEVAL.md` (default: project tags must differ on at least one axis from a small fixed taxonomy; **decision deferred to day 1 verification** if the project metadata does not yet have tags).
17. **Schema-as-living-config (Karpathy steal 1).** Edit Pass 2 prompt loader to inject the contents of `docs/spec/DEVNEURAL.md` into the system prompt at every call.
18. **Frozen flag honour (WI-2).** Edit ingest path to skip pages with `frozen: true` frontmatter.
19. **Pause mode (WI-5).** Implement env-driven pause logic in the decay scheduler.
20. **Brainstorm session-end pipeline auto-distillation (BF-7).** Edit `07-daemon/src/lex/session-end.ts` (**verify on day 1**: actual filename) so on every session end:
    - **Atomic flush ordering (mandatory):** the session-end pipeline holds a session-level lock and runs in this exact order, with each step completing fully before the next begins:
       1. Stop accepting new transcript chunks for this session.
       2. Drain any in-flight transcription jobs from the GPU queue for this session_id (block until empty).
       3. Persist the final transcript and update `brainstorm_sessions.ended_at`.
       4. Force-flush wiki ingest (existing behaviour, retained).
       5. Run Pass 2 against the full transcript; produce `wiki_drafts` rows.
       6. Refresh rolling session summary; write to `raw_chunks` with `kind='brainstorm-summary'`.
       7. Set `distilled_at`.
       8. Release the session lock.
       Browser close, Stop button, spoken "end session", and PTY exit all funnel through the same lock; only one path actually executes the pipeline. The others wait or no-op when they observe the session is already terminated. This prevents partial drafts from racing transcript flush.
    - Compute confidence per draft (Appendix H).
    - Write `distilled_at` on the brainstorm session row.

Day 2 commit checkpoint: `feat(brainstorm,curator,privacy): wave 1 code wiring`.

### Day 3: observability + dashboard + tests

21. **Curator instrumentation write paths (CI-1, CI-2, CI-3).** Edit curator at `UserPromptSubmit` time to write to `curator_log`. Edit follow-up classifier (existing regex + new explicit signals) to write `curator_signal`.
22. **Confidence score on injection (CI-5).** Compute and persist; expose in `/sessions/:id` injected_pages array.
23. **Curator Health endpoint (CI-6) + card.** Implement `GET /stats/curator-health`. Build `CuratorHealthCard.tsx`.
24. **Brainstorm KPI endpoint + tiles (BF-12).** Implement `GET /stats/brainstorm-kpi`. Build `BrainstormKpiTiles.tsx`.
25. **Outbound endpoint + card (PB-3).** Implement `GET /stats/outbound`. Build `OutboundCard.tsx`.
26. **Synthetic canary (CI-7).** Implement `07-daemon/scripts/canary.ts`. Schedule via the existing scheduled-task mechanism (**verify on day 1**: confirm scheduler).
27. **Schema regression suite (CI-8).** Create `07-daemon/tests/schema-regression/` with 50 fixtures and a runner. Schedule nightly.
28. **README edit (PB-5, BF identity).** Update README to drop "your data never leaves your machine" and replace with the accurate statement (PB-5 text). Add a paragraph "DevNeural is brainstormer-first" near the top.
29. **`outbound.md` at repo root (PB-1).** Write per template in section 7.
30. **Integration test scaffolding (TC-1).** Stand up `07-daemon/tests/integration/` directory and the brainstorm + curator tests. The other layers can land in Wave 2 if time pressure forces; brainstorm + curator are the priorities.

Day 3 commit checkpoints: `feat(dashboard): curator health + brainstorm kpi + outbound tiles`, `chore(docs): brainstormer-first README + outbound.md`, `test(integration): brainstorm + curator golden paths`.

### Wave 1 sign-off checklist

- [ ] All migrations 001-009 applied; data root validated.
- [ ] `npm test` green.
- [ ] New integration tests green: brainstorm.int, curator.int.
- [ ] Schema regression suite runs and passes against a baseline.
- [ ] Curator Health card renders on the dashboard with non-zero data after 24 hours.
- [ ] Brainstorm KPI tiles render with correct counts.
- [ ] Outbound card renders; brainstorm-outbound-count shows 0.
- [ ] Outbound log captures at least one Pass 2 fallback or verifier call (induce one in test mode).
- [ ] Privacy regression test passes (BF-4 brainstorm forbidden assertion).
- [ ] README and `outbound.md` updated.
- [ ] `TODO.md` Phase Two queue replaced with a pointer to this file.
- [ ] Backup taken; commit hash recorded in `docs/SESSION-HANDOVER.md`.

---

## 11. Wave 2 execution

Effort: ~5 days. Day-by-day below. Track A (brainstorm-first + wiki proof) and Track B (Lex critical path) run in parallel where the user has bandwidth; if executing sequentially, complete Track A first because it owns the privacy and instrumentation invariants Track B benefits from.

### Wave 2 prerequisite migrations (apply on day 1, ahead of code)

Wave 2 introduces tables Codex-review flagged as referenced-but-undefined. They land first to avoid forward references.

```
-- 010-audit-findings.sql
CREATE TABLE audit_findings (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL CHECK (source IN ('lint','self-audit','canary','user-flag','schema-regression')),
  severity        TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  page_slug       TEXT,                 -- nullable; some findings are not page-scoped
  brainstorm_id   TEXT,                 -- nullable
  finding         TEXT NOT NULL,        -- human-readable description
  detail          TEXT,                 -- structured JSON if applicable
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at     TEXT
);
CREATE INDEX audit_findings_status   ON audit_findings(status, created_at);
CREATE INDEX audit_findings_page     ON audit_findings(page_slug);

-- 011-heartbeat-log.sql
CREATE TABLE heartbeat_log (
  id              TEXT PRIMARY KEY,
  ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  daemon_pid      INTEGER NOT NULL,
  daemon_version  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('posted','ack','no-ack','watcher-alarm')),
  detail          TEXT
);
CREATE INDEX heartbeat_log_ts ON heartbeat_log(ts);

-- 012-crossproject-fallback-log.sql
CREATE TABLE crossproject_fallback_log (
  id              TEXT PRIMARY KEY,
  candidate_slug  TEXT NOT NULL,
  reason          TEXT NOT NULL,        -- 'no-tags-block','no-tags-permissive','no-tags-pause'
  participating_projects TEXT NOT NULL, -- JSON array of slugs
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX crossproject_fallback_log_day ON crossproject_fallback_log(created_at);

-- 013-backfill-review-queue.sql
CREATE TABLE backfill_review_queue (
  id              TEXT PRIMARY KEY,
  brainstorm_id   TEXT NOT NULL,
  candidate_page_slug TEXT NOT NULL,
  cosine          REAL NOT NULL,
  band            TEXT NOT NULL CHECK (band IN ('high','borderline','low')),
                                        -- high (>=0.85) auto-link, borderline (0.65..0.85) review, low (<0.65) ignore
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','rejected','skipped')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at     TEXT,
  resolved_by     TEXT
);
CREATE INDEX backfill_review_queue_status ON backfill_review_queue(status, band);
```

### Day 1: backend prerequisites + heartbeat + GPU queue

1. **Pre-flight backup** (always).
2. Apply migrations 010 through 013, plus 013a (`meeting_action_items` from section 3.9).
3. **GPU job queue (OP-3 / A11).** Implement `07-daemon/src/gpu/queue.ts`. Single in-process queue with priority lanes:
   - Lane 0 (highest): curator path (recall + injection latency-critical).
   - Lane 1: voice transcription jobs (whisper.cpp).
   - Lane 2: Pass 2 ingest jobs.
   - Lane 3: lint, self-audit, schema-regression nightly jobs.
   The queue picks from highest non-empty lane. Long jobs in lane 2 or 3 do **not** delay lane 0 because the queue is preemptive at-job-boundary: as soon as a lane-0 task arrives, the queue stops dispatching new work until the lane-0 task completes. (It does not preempt mid-job; that is acceptable for the curator's 80ms-P50 budget because individual GPU calls are sub-50ms.)
4. **VRAM monitor.** Read NVIDIA-SMI (or equivalent) every 5s; if free VRAM < threshold, lane 2/3 ingest jobs back off (sleep 10s and retry). Lane 0 and 1 always run.
5. **External heartbeat (OP-1 / A12).** Implement `07-daemon/src/heartbeat/poster.ts`. Writes to `heartbeat_log` and POSTs to `DEVNEURAL_HEARTBEAT_URL` if set.
6. **Heartbeat watcher service.** Build the chosen option (Appendix I). Wave 2 ships Option A: tiny standalone Windows Service on port 3748 listening for `POST /heartbeat`. Service repo: `07-daemon/heartbeat-watcher/` (separate Node script + nssm or sc.exe service registration). Documentation in `docs/install/HEARTBEAT.md`.
7. **Native OS toast fallback (OP-2 / A13).** Reuse the existing notification hook plumbing. When web push fails, fall back to PowerShell `BurntToast` module (or equivalent). Dependency: `BurntToast` PowerShell module installable via `Install-Module BurntToast`. Document in `docs/install/NOTIFICATIONS.md`.
8. **Raw chunks cull rule (OP-4 / A14).** Daily scheduled job. Walks `raw_chunks` for rows with `kind != 'brainstorm-summary'`, `created_at < now - 180 days`, AND zero `curator_signal` references. Archives them to a sibling table `raw_chunks_archived` and drops them from the vector index. Brainstorm chunks (`brainstorm_chunks` table) untouched.

Day 1 commit: `chore(db,gpu,heartbeat): wave 2 day 1 prerequisites`.

### Day 2: brainstorm-first dashboard surface

9. **`/brainstorms` route + components (BF-5 / A1).**
   - `08-dashboard/app/brainstorms/page.tsx` calls `GET /brainstorms` and renders `BrainstormList`.
   - `08-dashboard/app/brainstorms/[id]/page.tsx` calls `GET /brainstorms/:id` and renders `BrainstormDetail`.
   - Top-level nav entry added per section 5.4.
   - Filter chips wired (project, mode, date).
10. **`/drafts` route + components (BF-7 review path / A2).**
    - `08-dashboard/app/drafts/page.tsx` lists pending drafts.
    - `DraftEditor.tsx` modal supports inline edits + promote with conflict semantics from section 4.1.
    - All four conflict cases tested: slug collision, frozen target, superseded race, target-drift.
11. **Audio retention + player (BF-11 / A4).**
    - Daemon serves `GET /brainstorms/:id/audio` with Range support; reads from `data/brainstorms/<id>/audio/<file>` (data-root-relative resolution).
    - **Audio storage canonicalised to one file plus cue offsets.** Per session, a single `<session_id>.opus` (or `.wav`) plus a sibling `<session_id>.cues.json` listing `[{ turn_index, start_ms, end_ms }]`. The capture rig writes both atomically at session end. (Earlier "per-utterance window OR continuous" wording is replaced.)
    - `AudioPlayer.tsx` honours iOS gesture rules; default playback rate 0.9 per user preference.
    - Audio sensitivity note: `data/brainstorms/<id>/audio/` inherits the data root permissions; users running on a multi-user host should set folder ACL to `Users:None / Owner:FullControl`. Documented in `docs/install/AUDIO-VIDEO.md`.

Day 2 commit: `feat(dashboard,brainstorm): wave 2 day 2 routes + audio`.

### Day 3: linkage, lineage, backfill

12. **Bidirectional linkage polish (BF-7 lineage, WI-4 / A3).** Wave 1 wired `source_brainstorms` and `derived_from_brainstorm` on promote. Wave 2 day 3 adds the wiki page detail modal section "Source brainstorms" with deep-links to each brainstorm.
13. **Backfill (BF-13 / A5).** Implement `npm run backfill-brainstorms` (despite the name, also handles meetings):
    - Walk `data/brainstorms/` for sessions captured before 2026-05-09 that lack `brainstorm_chunks` rows.
    - **Kind classification (BF-14):** for each legacy session, infer kind from mode. `mode='conversation'` or `mode='push-to-talk'` -> `kind='brainstorm'`. `mode='notes'` -> default `kind='meeting'` (per the user's explicit clarification 2026-05-10). Surface a per-session override UI at `/brainstorms/backfill-review` so the user can flip a mis-classified session before lineage runs.
    - For each, ingest the legacy transcript into the new `brainstorm_chunks` shape; regenerate summary if missing.
    - **Brainstorm sessions only**, compute lineage: cosine between every existing wiki page and every brainstorm summary. Place each (page, brainstorm) pair into `backfill_review_queue` with a band: `high` (cosine >= 0.85, auto-link), `borderline` (0.65..0.85, manual review), `low` (<0.65, ignore).
    - High-band: write `source_brainstorms` directly; mark `linked` and set `derived_from_brainstorm: true` ONLY if the band is `high` AND the brainstorm content represents the page's primary evidence (heuristic: cosine >= 0.90 OR at least 30% body overlap; otherwise leave `derived_from_brainstorm: false` to avoid false lineage).
    - Borderline-band: surface in dashboard at `/brainstorms/backfill-review` with one-click link or reject. Stop condition: queue empty OR user dismisses.
    - Low-band: written to `crossproject_fallback_log`-style audit log for traceability; never linked.
    - **Meeting sessions:** no auto-lineage to wiki pages by default. The user must explicitly call `POST /meetings/:id/promote-to-wiki` if they want a wiki page from a meeting. Backfill leaves meetings as `kind='meeting'`, populates `meeting-summary` artifact if absent, and stops there.
14. **Auto-ingest of audit documents (A6).** Periodic job (daily) walks `voice-review.md` plus any `docs/audit/*.md`. Each gets a synthetic `brainstorm_sessions` row with `mode='notes'`, `kind='brainstorm'` (explicit override of the default `notes -> meeting` rule from BF-14), `provenance='audit-document'`, `project_slug=NULL`, `audio_path=NULL`, `consent_acked=0` (no audio is ever attached, so consent is irrelevant), and chunked into `brainstorm_chunks`. Future Lex recall surfaces them.

    **Why the kind override:** audit documents are written reflection on the system itself (the user's own thinking captured as text), not third-party speech. They belong in the brainstorm retrieval class and must not inherit meeting-class privacy treatment (which would block lineage and force them into a meeting-recall intent). Synthetic audit sessions are also exempt from the `/meetings` route (filtered out by `provenance='audit-document'`) and from auto-distillation to wiki drafts (BF-7 only fires when `provenance='voice'`).

Day 3 commit: `feat(brainstorm): wave 2 day 3 lineage + backfill`.

### Day 4: wiki integrity + curator polish

15. **Lint as nightly (Karpathy steal 2 / A7).** Existing lint module promoted to a scheduled task. Findings flow to `audit_findings` with `source='lint'`. Dashboard `LintFindingsPanel` component (new) lists open findings with severity and one-click "open page".
16. **LLM self-audit (Karpathy steal 3 / A8).** Periodic task spawned via the existing PTY-spawn mechanism in fresh-context mode. Picks 10 random wiki pages, asks "are these accurate, useful, well-scoped?" Findings written to `audit_findings` with `source='self-audit'`.
17. **Confidence + "this looks wrong" UI (CI-4, CI-5 / A9).** `InjectionRow.tsx` renders the confidence pill and the "this looks wrong" button. Button POSTs to `/curator/wrong`; weight drop and self-audit flag implemented.
18. **`last_verified` lint flag (WI-3 / A10).** Lint reads frontmatter; pages where `last_verified IS NULL` produce a `low`-severity finding "page never verified"; pages where `last_verified < now - 90 days` produce a `medium`-severity "page stale, recheck recommended" finding.
19. **Pause mode dashboard control (A15).** Toggle in `/system` route writes the env var override into a runtime config table; daemon honours `pause_mode` from runtime config first, env second.

Day 4 commit: `feat(wiki,curator): wave 2 day 4 integrity + ui polish`.

### Day 5: Lex track B (parallel-capable; sequential listing here)

20. **Prompt versioning archive (LX-1 / B1).** Daemon writes `07-daemon/data/lex-prompts/<version>.md` on every prompt change. Version is monotonic ISO timestamp + short hash. Existing prompts retroactively backfilled into the archive on first run.
21. **A/B replay harness (LX-2 / B2).** `npm run lex-replay -- --input <fixture> --version-a <vA> --version-b <vB>` runs both versions through a hermetic Lex spawn; emits side-by-side diff at `07-daemon/lex-replay-output/<timestamp>/diff.md`. Dashboard `LexReplayViewer` component renders the diff.
22. **Per-mode few-shot (LX-3 / B3).** Files at `07-daemon/data/lex-prompts/few-shot/<mode>.md`. Three files: `conversation.md`, `push-to-talk.md`, `meeting-notes.md` (BF-18). Loader reads the file matching the active mode and concatenates into the system prompt at runtime. The meeting-notes few-shot emphasises listen-and-summarise, no participation, no opinions, action-item extraction with attendee mapping.
23. **Refusal contract block (LX-4 / B4).** New `07-daemon/data/lex-prompts/refusal-contract.md` block with explicit dont-do-this examples. Always loaded. Plus a meeting-specific block at `07-daemon/data/lex-prompts/refusal-contract-meeting.md` that adds: "do not interject; do not opine; do not predict; capture and structure only; flag any direct address to you with `<addressed>` tag and respond minimally."
24a. **Meeting routes UI (BF-15, BF-17, 5.1).** `08-dashboard/app/meetings/page.tsx` and `[id]/page.tsx`. Components: `MeetingList`, `MeetingDetail`, `ActionItemList`, `AttendeeChips`, `ConsentGate`. The detail page shows audio purge countdown when `audio_purges_at` is non-null. The promote-to-wiki action surfaces only on user click.
24b. **Lex three-level awareness model (LX-7, LX-8, Appendix R).** Implement L1 broadcaster scaffolding (idle suppression, diff-only emit, token budget). Implement L2 `recent_context()` tool exposed to Lex via the existing tool-spawn mechanism. Implement push-on-change for actionable events (audit findings, due reminders, dropped drafts, canary failures). Per-mode verbosity rules enforced; meeting mode disables all awareness.
24. **Inline thumbs UI (LX-5 / B5).** `LexThumbs.tsx` per Lex turn. POSTs to `/lex/feedback`. Tested against `lex_feedback` schema.
25. **Random artifact sampling (LX-6 / B6).** Daily, the dashboard surfaces 5 random recent artifacts on the home page for one-click correct/incorrect labelling. Sample pool is the canonical artifact enum from section 3.10: `research-note`, `wiki-draft`, `project-intent`, `notes-summary`, `meeting-summary`, `meeting-action-item`. Sampling is stratified so meeting artifacts cannot crowd out brainstorm artifacts when meeting volume spikes (target floor: at least 2 of 5 from brainstorm artifacts when any exist). Labels feed `audit_findings` with `source='user-flag'`.

Day 5 commit: `feat(lex): wave 2 day 5 personality + feedback loop`.

### Wave 2 sign-off checklist

- [ ] Migrations 010 through 013 applied.
- [ ] All Wave 2 endpoints respond per section 4.
- [ ] All Wave 2 components render and pass axe a11y sweep (no violations).
- [ ] Audio replay verified on at least one historic and one recent brainstorm.
- [ ] Backfill completed; brainstorm count and lineage coverage reflect history; backfill_review_queue empty or user-dismissed.
- [ ] Lint nightly + self-audit nightly running; findings flow into `audit_findings`.
- [ ] Heartbeat verified end-to-end (induce a daemon stop; phone alerts within 10 minutes).
- [ ] Native toast fallback verified (block web push, observe toast).
- [ ] GPU queue priority lanes verified: long Pass 2 job in lane 2 does not block a lane-0 curator decision in load test.
- [ ] Raw chunks cull job ran at least once with non-zero archived count or zero with reason.
- [ ] Lex prompt versioning archive populated with at least 2 versions.
- [ ] A/B replay harness produces a side-by-side diff for a fixture prompt.
- [ ] Thumbs UI records into `lex_feedback`.
- [ ] All 4 promote-conflict cases tested.
- [ ] Schema regression suite has 50 fixtures committed and graduates from advisory to enforcing.

---

### Wave 3 - Orb (Lane A)

Wave 3 Lane A ships in one focused block: unified graph data layer, 4-type canvas renderer, filter chips, double-click side panel, and recent-activity glow. Step numbering continues from Wave 2 step 25.

**Step 26. Backend: `GET /graph/unified` endpoint.**
New file `07-daemon/src/dashboard/unified-graph.ts`. Returns nodes from brainstorm_sessions (kind=brainstorm), wiki pages (kind=wiki), projects from registry (kind=project), and meeting sessions (kind=meeting), plus edges from:
- wiki frontmatter `source_brainstorms` (lineage edges)
- wiki frontmatter `source_meetings` (lineage edges)
- `brainstorm_sessions.project_slug` matched to project nodes (project-spawn edges)
- wiki cross-reference sections (wiki-cross-ref edges)
Response type: `UnifiedGraphPayload` with typed `UnifiedGraphNode` and `UnifiedGraphEdge`.

**Step 27. Dashboard: `08-dashboard/src/orb/` directory.**
Per plan conflict-avoidance rule, all new unified-orb logic lives in `08-dashboard/src/orb/`. Files:
- `types.ts` - shared types for UnifiedGraphNode, UnifiedGraphEdge
- `colors.ts` - color palette and shape constants for 4 node types
- `UnifiedOrb.tsx` - main component, extends existing canvas-2d renderer idiom
- `FilterChips.tsx` - chip row for brainstorm/wiki/project/meeting toggles
- `SidePanel.tsx` - double-click connection panel with click-to-jump
The existing `/orb` page (`08-dashboard/app/orb/page.tsx`) updated to render `UnifiedOrb` in place of the wiki-only `Orb`, with the wiki-only `Orb` remaining intact for embedded use on the home page.

**Step 28. Render 4 node types in canvas-2d renderer.**
- brainstorm nodes: warm amber (`oklch(75% 0.17 60)`), circle with slight inner glow, size by chunk_count proxy (started_ms age as weight fallback).
- wiki nodes: cool blue (`oklch(64% 0.20 295)` canonical / `oklch(72% 0.13 270)` pending), existing status coloring preserved; draft state shown as muted ring variant.
- project nodes: neutral slate (`oklch(58% 0.04 260)`), square drawn via canvas fillRect rotated 45deg (diamond shape to visually distinguish from circles).
- meeting nodes: teal-green (`oklch(68% 0.14 175)`), circle with dashed outer ring to signal "archivable" nature.
- Edge colors by kind: lineage=green, wiki-cross-ref=blue (existing heat gradient), project-spawn=purple.
- Files are NEVER nodes. Drafts are a color variant on wiki nodes, not separate nodes.

**Step 29. Double-click side panel.**
`SidePanel.tsx` opens on double-click of any node. Lists all connected items grouped by kind. Each item is click-to-jump: wiki pages navigate to `/wiki?page=`, brainstorms to `/brainstorms/`, projects to `/projects`, meetings to `/meetings/`. Connection list sourced from edges plus side-channel: wiki pages include `source_files` frontmatter list as a "Source files" section (files listed but not graph nodes).

**Step 30. Recent-activity glow.**
Nodes touched in the last 24 hours receive the animated expanding-ring treatment (reuses existing `isRecentlyPromoted` pattern). Recency determined by: brainstorm `started_ms` or `ended_ms`, wiki page `last_modified`, project `last_seen`. Glow color matches node type (amber for brainstorm, blue-violet for wiki, slate for project, teal for meeting).

**Step 31. Filter chips.**
`FilterChips.tsx` renders 4 chip buttons: `[brainstorms] [wiki] [projects] [meetings]`. Each chip toggles visibility of its node type in the graph. All chips active by default. Chips follow existing pill-button styling from the orb controls row. Active chip has `bg-brand/20 ring-1 ring-brand/40` treatment per existing labels button.

**Deferred (cut for scope):**
- Search within the orb + keyboard node navigation: left as a TODO comment in `UnifiedOrb.tsx` and noted below.
- TODO: add orb-level search (filter nodes by title match) and keyboard nav (arrow keys to hop between connected nodes, Enter to open side panel). Implement in Wave 4 or as a standalone polish commit.

---

## 12. Wave 3 execution

Effort: ~5 days. Gated on Wave 2 signals (specifically: Curator Health card green; CI-7 canary green for at least 7 days; backfill complete).

### Wave 3 prerequisite migrations (apply on day 1)

```
-- 014-brainstorm-edges.sql
CREATE TABLE brainstorm_edges (
  id              TEXT PRIMARY KEY,
  src_brainstorm  TEXT NOT NULL,
  dst_brainstorm  TEXT NOT NULL,
  cosine          REAL NOT NULL,
  edge_kind       TEXT NOT NULL DEFAULT 'topic-recurrence' CHECK (edge_kind IN ('topic-recurrence','manual')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (src_brainstorm < dst_brainstorm),  -- canonical ordering, prevents duplicate (a,b) and (b,a)
  FOREIGN KEY (src_brainstorm) REFERENCES brainstorm_sessions(id),
  FOREIGN KEY (dst_brainstorm) REFERENCES brainstorm_sessions(id)
);
CREATE UNIQUE INDEX brainstorm_edges_pair ON brainstorm_edges(src_brainstorm, dst_brainstorm);
CREATE INDEX        brainstorm_edges_cos  ON brainstorm_edges(cosine);
```

### Day 1: cross-brainstorm linking

1. **Pre-flight backup.**
2. Apply migration 014.
3. **Cross-brainstorm auto-link (BF-8 / W3-1).** Implement `07-daemon/scripts/brainstorm-edges.ts`. Daily scheduled job:
   - Compute cosine between every pair of brainstorm summaries (or, for scale, pairs above a candidate-shortlist filter using BM25 similarity first).
   - Threshold default 0.65 for `topic-recurrence`. Configurable: `DEVNEURAL_BRAINSTORM_EDGE_THRESHOLD`.
   - Writes new edges to `brainstorm_edges`. Existing edges below threshold are dropped (so threshold tuning re-renders cleanly).
   - Performance budget: full pass under 60s for current corpus size (5,185 raw chunks scale assumption); revisit if exceeded.

Day 1 commit: `feat(brainstorm): wave 3 day 1 cross-brainstorm edges`.

### Day 2: unified orb

4. **`/graph/unified` endpoint.** Implement `GET /graph/unified` returning:

```ts
{
  nodes: Array<{
    id: string;
    kind: 'brainstorm' | 'wiki' | 'project';
    title: string;
    weight: number;
    metadata: Record<string, unknown>;
  }>;
  edges: Array<{
    source: string;
    target: string;
    kind: 'brainstorm-recurrence' | 'lineage' | 'wiki-cross-ref' | 'project-spawn';
    weight: number;
  }>;
}
```

   - Brainstorm nodes from `brainstorm_sessions` (only sessions with at least 1 derived artifact OR 5+ chunks; threshold avoids visual noise).
   - Wiki nodes from `wiki_meta`.
   - Project nodes from the existing project registry (top-N by activity).
   - Edges:
     - `brainstorm-recurrence` from `brainstorm_edges`.
     - `lineage` from wiki page `source_brainstorms` frontmatter.
     - `wiki-cross-ref` from existing wiki cross-references.
     - `project-spawn` from brainstorms whose `project_slug` is non-null and matches a wiki page's project assignment.
5. **Orb refactor (BF-9 / W3-2).** Refactor `08-dashboard/components/Orb.tsx` to consume `/graph/unified`. Node visual style:
   - brainstorm = warm amber, slight glow, size by chunk count.
   - wiki = cool blue, ring brightness by weight, size by weight.
   - project = neutral grey, square node, size by activity.
   - Edge color by kind (lineage = green, recurrence = orange, cross-ref = blue, spawn = purple).
   - Filter chips replace prior toggles: `[brainstorms] [wiki] [projects]` chips toggle visibility but the underlying graph is one graph.
6. **Performance budget.** 16ms paint at typical density (200 nodes total). Lighthouse-equivalent perf assertion in tests.

Day 2 commit: `feat(dashboard): wave 3 day 2 unified orb`.

### Day 3: query mode + awareness

7. **"What was I thinking" mode (BF-10 / W3-3).** Server side already wired in Wave 1 (intent override on `/lex/recall`). Wave 3 day 3:
   - Add Lex command grammar: user says or types `recall: brainstorm-only` or `recall: what-was-i-thinking <topic>`. Lex command parser dispatches to recall with the matching intent.
   - Add dashboard search filter: a chip on `/brainstorms` and `/sessions` search that toggles intent.
8. **Awareness broadcaster gate check (LX-7 / W3-4).** Before implementing, verify CI-6 (Curator Health) green for 7 consecutive days. If not, defer to next wave. Document gate decision in `docs/spec/PHASE-TWO-DAY-1-VERIFICATIONS.md` under a Wave 3 section.
9. **Awareness broadcaster (LX-7 / W3-4).** If gate passes:
   - Implement `07-daemon/src/lex/awareness-broadcaster.ts`. 5-15s tick (default 10s) writes a system-message-shaped block to Lex's PTY stdin: active sessions, brainstorms, recent artifacts, flagged pages.
   - Block format: tagged ` <live_state>...</live_state>` per existing tag conventions.
   - Configurable: `DEVNEURAL_LEX_AWARENESS_INTERVAL_MS`, `DEVNEURAL_LEX_AWARENESS=true|false`.
   - Off by default; user opts in.

Day 3 commit: `feat(lex): wave 3 day 3 query mode + awareness broadcaster`.

### Day 4: tests, drills, docs

10. **Restore drill + runbook (OP-5 / W3-5).**
    - Spin up parallel daemon at `127.0.0.1:3748` against backup data on a separate temp data root.
    - Sanity-check: load home, list brainstorms, list wiki, run a recall query, confirm responses match production.
    - Document time-to-restore in `docs/install/RESTORE-DRILL.md` with a runbook for the next drill.
    - Mark stopping criterion S-11 green.
11. **Cold-start integration test (TC-3 / W3-6).** Implement `07-daemon/tests/integration/cold-start.int.test.ts`:
    - Register a brand-new project with valid tags.
    - Ingest one fixture turn.
    - Issue a `UserPromptSubmit` and assert the curator returns at least one cross-project page candidate that satisfies CP-1.
    - Assert the response time is under the curator P50 budget.
12. **Hybrid retrieval doc (OP-6 / W3-7).** Publish `docs/spec/RETRIEVAL.md` with:
    - The exact scoring formula (matches section 4.2).
    - The tunable parameters and their defaults.
    - The intent override behaviours.
    - The bounded older-is-better prior formula.
    - Worked examples for each intent.
13. **Database doc (`docs/spec/DATABASE.md`).** Land if not already from Wave 1 day 3. Captures the SQLite-now / Postgres-later decision and the migration catalogue from Appendix C.

Day 4 commit: `test(integration),docs(spec): wave 3 day 4 drills + runbooks + retrieval doc`.

### Day 5: spec review + polish + done check

14. **P2-0 adversarial spec review (W3-8).** With real numbers from Curator Health, Lex feedback, outbound logs, and lineage coverage now in hand, run an adversarial review of `docs/spec/FUNCTIONAL-SPEC.md` against the actual operating system. Output at `docs/spec/FUNCTIONAL-SPEC-REVIEW-001.md`. Use the same format as `voice-review.md` (holes, decisions, plug-the-holes plan).
15. **P2-4 UI fine-tuning (W3-9).** Per voice-review.md TODO. Polish: brainstorm rows in `/sessions`, deep-link `/wiki <-> /orb`, "now playing" indicator, mobile PWA polish.
16. **P2-5 docs refresh (W3-9).** Update README to reflect Phase Two final state. Update `docs/SESSION-HANDOVER.md` with Wave 1 + 2 + 3 completion. Move outdated `TODO.md` items to `archive/todo-2026-05.md`.
17. **Stopping-criteria check.** Render `/stopping-criteria` route. Verify all 13 criteria in section 13 are green. If green: declare Phase Two solid and mark `docs/SESSION-HANDOVER.md` accordingly. If any red: produce a short list of remaining work and decide go/no-go with the user.

Day 5 commit: `chore(docs,polish): wave 3 day 5 spec review + done check`.

### Wave 3 sign-off checklist

- [ ] Migration 014 applied.
- [ ] Brainstorm edges populated; orb shows recurrence edges.
- [ ] `/graph/unified` returns valid response with all node types.
- [ ] Unified orb renders all node types; filter chips work; performance under 16ms paint at typical density (200 nodes).
- [ ] "What was I thinking" mode returns expected results on a fixture brainstorm corpus.
- [ ] Awareness broadcaster gate decision documented; if passed, broadcaster live in Lex sessions and verified.
- [ ] Restore drill complete with time documented.
- [ ] Cold-start test passes.
- [ ] `docs/spec/RETRIEVAL.md` published.
- [ ] `docs/spec/DATABASE.md` published.
- [ ] `docs/spec/FUNCTIONAL-SPEC-REVIEW-001.md` complete.
- [ ] All 13 stopping criteria evaluated; "Phase Two solid" indicator green or short-list documented.

---

## 13. Stopping criteria and verification

DevNeural Phase Two is "solid" when **all** of the following are true at the same time:

| ID | Criterion | Source | Window |
|---|---|---|---|
| S-1 | Curator useful injection rate >=60% on complex prompts (>=5 turn sessions) | `/stats/curator-health` | rolling 30 days |
| S-2 | Explicit thumb-up rate on injections >=70% | `curator_signal` source='user-explicit' | rolling 30 days |
| S-3 | Schema regression canary green for 14 consecutive days | `tests/schema-regression/` runner | continuous |
| S-4 | LLM self-audit zero high-severity findings for 7 consecutive days | `audit_findings` table (created in Wave 2 A8) | continuous |
| S-5 | Lint zero high-severity findings for 7 consecutive days | nightly lint output | continuous |
| S-6 | One golden-path integration test per layer passing on every commit | CI | per commit |
| S-7 | External heartbeat alerted at least once and recovered cleanly | `heartbeat_log` (Wave 2 A12) | one-time |
| S-8 | Brainstorm lineage coverage >=80% | `/stats/brainstorm-kpi` `wiki_lineage_coverage` | snapshot |
| S-9 | Brainstorm search latency P50 <300ms | benchmark suite | rolling 7 days |
| S-10 | Audio replay functional on >=1 historic and >=1 recent brainstorm | manual verification | one-time |
| S-11 | Restore drill completed; time-to-restore documented | `docs/install/RESTORE-DRILL.md` | one-time |
| S-12 | Outbound dashboard tile shows zero brainstorm content has ever been sent off-host | `/stats/outbound` `brainstorm_outbound_count_alltime` | continuous |
| S-13 | Cold-start test green | `tests/integration/cold-start.int.test.ts` | per commit |

A `/stopping-criteria` dashboard route renders the live state of all 13 criteria. When all are green, the dashboard surfaces a "Phase Two solid" indicator.

---

## 14. Rollback and recovery

### 14.1 Per-wave rollback

Every wave commits behind a feature flag where reasonable. Specifically:

- **Wave 1 source-class reweighting (BF-1)** is gated by env `DEVNEURAL_RETRIEVAL_REWEIGHT_ENABLED=true` (default true on master after Wave 1 commit). Set to false to fall back to the prior order.
- **Wave 1 outbound enforcement (BF-4)** is *not* gated; it is a hard contract. No flag.
- **Wave 1 schema migrations** are forward-only. Rollback is via backup restore (section 14.2).
- **Wave 2 unified orb data path** ships behind `DEVNEURAL_ORB_UNIFIED=true` until validated.
- **Wave 3 awareness broadcaster** ships behind `DEVNEURAL_LEX_AWARENESS=true`.

### 14.2 Backup restore drill

Before every wave, run `npm run backup` and confirm the manifest. Note the snapshot id in `docs/SESSION-HANDOVER.md`.

If a wave proves catastrophic:

1. Stop the daemon.
2. `npm run restore -- --snapshot <id>`.
3. Confirm `npm run verify-backup` passes integrity check.
4. Restart the daemon.
5. Document the failure in `docs/SESSION-HANDOVER.md`.

### 14.3 Migration rollback

Each migration `NNN-<slug>.sql` ships with a sibling `NNN-<slug>.down.sql` reversing the change where possible. Some changes (table drops with backfilled data) cannot be safely reversed without a snapshot restore; the down script in those cases contains a comment stating "rollback via snapshot only" and aborts.

---

## 15. Open questions and day-1 verifications

Items the spec author could not fully decide without running the code. Resolve on the first morning of Wave 1.

| ID | Question | How to answer |
|---|---|---|
| Q-1 | Highest existing migration number in `07-daemon/scripts/migrations/`. | `ls 07-daemon/scripts/migrations`. Pick next number. |
| Q-2 | PK type for tables (TEXT vs INTEGER). | Inspect existing chunk table DDL; match. |
| Q-3 | Auth header / cookie name for dashboard endpoints. | Inspect `07-daemon/src/dashboard/auth.ts` (or equivalent). |
| Q-4 | Project metadata schema; does it already carry tags suitable for a domain-distance check? | Inspect the project registry. If absent, fall back to "different project_slug = different domain" until tags are added in a follow-up. |
| Q-5 | Session-end pipeline file path. | `grep -r 'session-end' 07-daemon/src`. |
| Q-6 | SW caching strategy for audio. | Inspect `08-dashboard/public/sw.js` (or service worker source). Audio should bypass cache. |
| Q-7 | Existing scheduler mechanism for nightly jobs. | Inspect `07-daemon/scripts/install-backup-task.ps1` and any `setupTaskScheduler` code. |
| Q-8 | Wiki frontmatter parser tolerates unknown fields. | Inspect `07-daemon/src/wiki/loader.ts` (or equivalent). If strict, add unknown-field tolerance before the frontmatter sweep migration. |
| Q-9 | Where transcripts for legacy brainstorms are stored on disk. | Inspect `data/brainstorms/` layout. Inform backfill script. |
| Q-10 | Domain-distance taxonomy. | If Q-4 returns no tags, propose a 5-axis taxonomy (language, runtime, layer, domain, lifecycle) and add to project metadata in a follow-up commit. |
| Q-11 | Existing draft / reminder schema patterns. Do not duplicate; align. | Inspect `07-daemon/src/reminders/schema.ts` and any draft analogue. |
| Q-12 | Confidence formula for `wiki_drafts.confidence`. Initial heuristic in this spec: schema validation + body-vs-wiki cosine match. Refine after observing real distributions. | Implement the heuristic in Wave 1 day 2; gather distributions in Wave 2; tune in Wave 3. |
| Q-13 | Dashboard stack confirmation: Next.js 15 App Router, Tailwind v4, Tanstack Query, Tremor. Inspect `08-dashboard/package.json` and adjust component file extensions / patterns if any version differs. |
| Q-14 | Scheduler shape for nightly jobs. SHOULD use a single in-process scheduler in the daemon (e.g. `node-cron` or a tiny custom tick) over multiple Windows scheduled tasks (one task = backup is fine; do not multiply). Confirm whether one already exists; if not, create at `07-daemon/src/scheduler.ts`. |
| Q-15 | Audio bundle format on disk today. Spec mandates `<session_id>.opus|.wav + <session_id>.cues.json` going forward. Inspect current capture rig output; if it uses per-utterance files, write a one-shot consolidator into the backfill script. |
| Q-16 | SQLite WAL mode on. Inspect daemon DB-open code; if not WAL, enable: `PRAGMA journal_mode=WAL;`. Required for read concurrency during backups and dashboard reads. |
| Q-17 | Dashboard auth scheme. Inspect existing PIN-cookie implementation. New endpoints in section 4.1 reuse the same scheme; do not introduce a parallel auth path. |
| Q-18 | Existing migration runner exists. If yes, integrate (section 3 protocol step 1a/1b). If no, build minimal runner (1c). Do not skip this question. |
| Q-19 | Rate-limiting on PIN auth. If absent, add. Trivially: max 5 failed attempts per 15 minutes per source IP. |
| Q-20 | NVIDIA-SMI availability for VRAM monitor. If `nvidia-smi` is not on PATH, fall back to a generous static guard (skip ingest if any whisper.cpp / ollama process is active for >2s). |

---

## Appendix A: file index

New files created in this spec (referenced above; consolidated for grep-ability):

- `07-daemon/scripts/migrations/001-schema-version-meta.sql`
- `07-daemon/scripts/migrations/002-add-model-id.sql`
- `07-daemon/scripts/migrations/003-brainstorm-chunks.sql`
- `07-daemon/scripts/migrations/004-brainstorm-sessions-deltas.sql`
- `07-daemon/scripts/migrations/005-wiki-drafts.sql`
- `07-daemon/scripts/migrations/006-outbound-log.sql`
- `07-daemon/scripts/migrations/007-curator-log.sql`
- `07-daemon/scripts/migrations/008-lex-feedback.sql`
- `07-daemon/scripts/migrations/009-wiki-frontmatter-sweep.ts`
- `07-daemon/scripts/migrations/010-audit-findings.sql`
- `07-daemon/scripts/migrations/011-heartbeat-log.sql`
- `07-daemon/scripts/migrations/012-crossproject-fallback-log.sql`
- `07-daemon/scripts/migrations/013-backfill-review-queue.sql`
- `07-daemon/scripts/migrations/013a-meeting-action-items.sql`
- `07-daemon/scripts/migrations/014-brainstorm-edges.sql`
- `07-daemon/src/db/migrate.ts` (if not present)
- `07-daemon/src/gpu/queue.ts`
- `07-daemon/src/scheduler.ts` (if not present)
- `07-daemon/heartbeat-watcher/` (separate sub-project)
- `07-daemon/scripts/brainstorm-edges.ts`
- `07-daemon/scripts/backfill-brainstorms.ts`
- `07-daemon/data/lex-prompts/refusal-contract.md`
- `08-dashboard/components/LintFindingsPanel.tsx`
- `08-dashboard/app/brainstorms/backfill-review/page.tsx`
- `08-dashboard/components/LexReplayViewer.tsx`
- `docs/spec/CODEX-REVIEW-001.md`
- `docs/spec/DATABASE.md`
- `docs/install/HARDWARE-PROFILE.md`
- `docs/install/NOTIFICATIONS.md`
- `07-daemon/src/heartbeat/poster.ts`
- `07-daemon/scripts/canary.ts`
- `07-daemon/tests/integration/*.int.test.ts`
- `07-daemon/tests/schema-regression/`
- `07-daemon/tests/security/outbound-brainstorm-forbidden.test.ts`
- `07-daemon/data/lex-prompts/<version>.md`
- `07-daemon/data/lex-prompts/few-shot/<mode>.md`
- `08-dashboard/app/brainstorms/page.tsx`
- `08-dashboard/app/brainstorms/[id]/page.tsx`
- `08-dashboard/app/drafts/page.tsx`
- `08-dashboard/components/BrainstormList.tsx`
- `08-dashboard/components/BrainstormDetail.tsx`
- `08-dashboard/components/AudioPlayer.tsx`
- `08-dashboard/components/DraftsQueue.tsx`
- `08-dashboard/components/DraftEditor.tsx`
- `08-dashboard/components/kpi/CuratorHealthCard.tsx`
- `08-dashboard/components/kpi/BrainstormKpiTiles.tsx`
- `08-dashboard/components/kpi/OutboundCard.tsx`
- `08-dashboard/components/sessions/InjectionRow.tsx`
- `08-dashboard/components/sessions/LexThumbs.tsx`
- `outbound.md`
- `docs/spec/RETRIEVAL.md`
- `docs/install/HEARTBEAT.md`
- `docs/install/RESTORE-DRILL.md`

Files modified:

- `README.md` (PB-5 + brainstormer-first paragraph)
- `TODO.md` (Phase Two queue replaced with pointer to this spec)
- `07-daemon/src/lex/recall.ts` (BF-1, hybrid scorer)
- `07-daemon/src/reinforcement/decay.ts` (BF-2, frozen flag)
- `07-daemon/src/ingest/pass2.ts` (BF-4, schema-as-living-config, outbound log)
- `07-daemon/src/ingest/cross-project.ts` (BF-4, CP-1, outbound log)
- `07-daemon/src/lex/session-end.ts` (BF-7 auto-distillation)
- `08-dashboard/app/page.tsx` (KPI strip additions)
- `08-dashboard/app/sessions/[id]/page.tsx` (InjectionRow + LexThumbs)
- `08-dashboard/components/Orb.tsx` (Wave 3 unification)

---

## Appendix B: commit message templates

Wave 1 commits (one per checkpoint):

```
chore(db): phase two migrations 001-009

Adds schema_version meta, model_id on chunk tables, brainstorm_chunks,
brainstorm_sessions deltas, wiki_drafts, outbound_log + trigger,
curator_log + curator_signal, lex_feedback, and a wiki-frontmatter
sweep that adds defaults to every existing page.
```

```
feat(brainstorm,curator,privacy): wave 1 code wiring

- Source-classed retrieval reweight (BF-1) with hybrid scorer.
- Decay scope tightened to non-frozen wiki pages only (BF-2, WI-2).
- Outbound rule enforcement: brainstorm content forbidden, daily cap (BF-4, PB).
- Cross-project promotion threshold raised to N=3 + domain-distance (CP-1).
- Schema-as-living-config: DEVNEURAL.md injected into Pass 2 prompt.
- Session-end auto-distillation writes pending wiki_drafts (BF-7).
```

```
feat(dashboard): curator health + brainstorm kpi + outbound tiles

Adds /stats/curator-health, /stats/brainstorm-kpi, /stats/outbound
endpoints and the corresponding KPI cards on the home strip.
```

```
chore(docs): brainstormer-first README + outbound.md

README updated to drop "data never leaves your machine" claim and
to lead with the brainstormer-first identity.

Adds outbound.md at repo root listing every off-host code path.
```

```
test(integration): brainstorm + curator golden paths

First two integration tests under 07-daemon/tests/integration/.
```

(No AI co-author tags. Per global CLAUDE.md.)

---

## Appendix C: Database choice and Postgres migration path

**Current state:** SQLite. Single-process daemon, single user, local-first. SQLite is the right choice today: zero ops, atomic backups, FTS5, decent vector extension support (`sqlite-vec`), and embedded into the daemon process.

**Future state (possible):** PostgreSQL. The user has flagged this as a flexibility consideration, not a committed migration.

**What stays the same in Postgres:**
- All TEXT primary keys with UUIDs.
- All ANSI SQL DDL (`CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`).
- All FK constraints.
- The general shape of every table in section 3.
- The core hybrid retrieval scorer (with `pgvector` standing in for `sqlite-vec`).

**What changes in Postgres (catalogue these now so a future migration is mechanical, not investigative):**

| SQLite construct | Postgres equivalent |
|---|---|
| `strftime('%Y-%m-%dT%H:%M:%fZ','now')` defaults | `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` or just `now()::text` |
| `CHECK (col IN (...))` | unchanged (works in both) |
| `CREATE TRIGGER ... BEGIN ... END` (SQLite syntax) | `CREATE TRIGGER ... EXECUTE FUNCTION` plus a PL/pgSQL function |
| `CREATE VIRTUAL TABLE ... USING fts5` | `tsvector` columns with `GIN` indexes |
| `sqlite-vec` BLOB embeddings | `pgvector` `vector(N)` columns |
| `INTEGER` rowid alias | not used in this spec; we use TEXT UUIDs everywhere |
| `WITHOUT ROWID` | not relevant in Postgres |
| Atomic file-level backup | `pg_dump` or streaming replication |

**Implementation guidance during Phase Two:**

1. Use TEXT UUIDs for every PK (already specified).
2. Keep DDL in plain SQL files; reserve the trigger logic for SQLite-specific files (e.g. `migrations/006-outbound-log.sqlite.sql`) so a Postgres branch can swap the trigger file without touching anything else.
3. Keep query logic in TypeScript (Knex, Kysely, or hand-written SQL) rather than as `VIEW`s where possible. A query in TS can be parameterised by dialect; a VIEW must be rewritten.
4. Encapsulate FTS5 use behind a single search function so swapping to `tsvector` later is one file, not many.
5. Encapsulate `sqlite-vec` use behind a single vector-search function for the same reason.
6. Document any SQLite-only optimisation in `docs/spec/DATABASE.md` (new) so the future migration plan has a checklist.

**Decision:** stay on SQLite for Phase Two. Revisit Postgres only if any of these become true: more than one concurrent writer (multi-user), more than ~10 GB of data, need for streaming replication, or a feature that genuinely requires Postgres (e.g. `LISTEN/NOTIFY` for cross-process events). None apply now.

`docs/spec/DATABASE.md` should be created in Wave 1 day 3 (alongside the README edit) capturing this decision and the migration catalogue above.

---

## Appendix D: System interconnect

```
                        +---------------------------+
                        |  Claude Code session(s)   |
                        |   (worker terminals)      |
                        +-----------+---------------+
                                    | hooks: Pre/Post/UserPromptSubmit/Stop/Notification
                                    | jsonl tail: ~/.claude/projects/<slug>/<session>.jsonl
                                    v
+------------------------------------------------------------------------------------+
|                       07-daemon (long-running, lazy-spawned)                       |
|                                                                                    |
|   +---------+   +-------+   +--------+   +----------+   +---------+   +---------+ |
|   | capture +-->+ Pass1 +-->+ Pass2  +-->+ wiki/    |   | curator |   | recall  | |
|   +---------+   +-------+   +--------+   +----------+   +---+-----+   +----+----+ |
|                                                            |              |       |
|                                                            v              v       |
|                                              +-------------+--------------+-----+ |
|                                              |  unified retrieval (hybrid)      | |
|                                              |  BM25 + vector + recency +       | |
|                                              |  source-class weights (BF-1)     | |
|                                              +-----+--------+-------+-------+---+ |
|                                                    |        |       |       |    |
|                                                    v        v       v       v    |
|                                            +-------+-+ +----+----+ ++----+ ++----+|
|                                            |brainstorm| | wiki   | |draft| |raw  ||
|                                            |  chunks  | | pages  | |s    | |chunk||
|                                            +----------+ +--------+ +-----+ +-----+|
|                                                                                    |
|   +-------------+    +----------------+    +-------------+    +----------------+  |
|   | reinforce   |    | lint (nightly) |    | self-audit  |    | canary (nightly)| |
|   |  decay (WI- |    |   (Karpathy)   |    |  (Karpathy) |    |   (CI-7)       | |
|   |   pages only|    +----------------+    +-------------+    +----------------+  |
|   +-------------+                                                                  |
|                                                                                    |
|   +-----------+     +-----------+     +-----------+    +---------------+          |
|   | outbound  |<--->| pass2     |     | cross-    |    | heartbeat     |          |
|   | log + cap |     | fallback  |     | project   |    | poster (OP-1) |          |
|   | (PB-2/3/4)|     | (Anthropic|     | verifier  |    +-------+-------+          |
|   +-----------+     |  opt-in)  |     | (Anthropic|            |                  |
|                     +-----------+     |  always   |            v                  |
|                                       |  on when  |    +-------+-------+          |
|                                       |   CP path)|    | external      |          |
|                                       +-----------+    | watcher (OP-1)|          |
|                                                        +---------------+          |
|                                                                                    |
|   +--------------+   +-----------------+   +---------------------+                 |
|   | session-end  |   | wiki_drafts     |   | brainstorm KPIs +   |                 |
|   | auto-distill |-->+  queue (BF-7)   |   | curator health +    |                 |
|   |   (BF-7)     |   +-----+-----------+   | outbound (sec 4.1)  |                 |
|   +--------------+         |               +----------+----------+                 |
|                            v                          |                            |
|                  +---------+----------+               |                            |
|                  | promote/edit/      |               |                            |
|                  | discard handlers   |               |                            |
|                  +--------------------+               |                            |
+----------------------------------------+--------------+----------------------------+
                                         |              ^
                                         | HTTP/WS      | HTTP
                                         v              |
                              +----------+-----+        |
                              |  08-dashboard  +--------+
                              |  (Next.js PWA, |
                              |   PIN auth)    |
                              +-------+--------+
                                      |
                                      v Tailscale (https) for mobile
                              +-------+--------+
                              |  iPhone PWA    |
                              +----------------+

                              +--------------------------------------+
                              | 09-bridge (VS Code extension)        |
                              | watches session-bridge/ and pastes   |
                              | queued prompts into terminals        |
                              +--------------------------------------+
```

Key data flows:

1. **Capture:** Claude Code hooks fire; jsonl appended; capture watcher reads and produces turn-bounded chunks; chunks land in `raw_chunks` (project) or `brainstorm_chunks` (brainstorm).
2. **Ingest:** Pass 1 distills; Pass 2 produces wiki page candidates; cross-project verifier may fire (only on CP-1 + N=3 + domain-distance, never on brainstorm-tagged content).
3. **Curate (real time):** on `UserPromptSubmit`, recall runs; source-class-weighted hybrid scoring picks 0 or 1 page; decision logs to `curator_log`; injection text appended to the prompt.
4. **Reinforce:** follow-up turn classified for hits/corrections; explicit thumbs override; weights move; daily decay (wiki pages only).
5. **Brainstorm session end:** session-end pipeline auto-distills; `wiki_drafts` rows queued; user reviews in `/drafts`; promote/discard.
6. **Observe:** dashboard pulls KPI endpoints; sparklines; Curator Health; Outbound; Brainstorm KPIs; Stopping criteria.

---

## Appendix E: Worked examples (brainstorm and meeting lifecycles)

Two walk-throughs that match the post-BF-14 rules. Use as models for integration tests and as user-facing documentation.

### E.1 Brainstorm session lifecycle (`kind='brainstorm'`)

1. **Start.** User opens `/sessions/new`, picks `mode='conversation'`, leaves project `general`. The daemon receives `POST /sessions/new { mode: 'conversation', project_slug: null }`. Per BF-14 the default `kind` derives to `brainstorm`. The daemon spawns a Lex PTY. `brainstorm_sessions` row inserted: `id=bs_2026-05-10_a1b2`, `project_slug=NULL`, `mode=conversation`, `kind=brainstorm`, `provenance=voice`, `consent_acked=0` (irrelevant for brainstorm), `started_at=2026-05-10T05:00:00Z`.
2. **Voice capture.** User speaks. whisper.cpp transcribes. Each finalised utterance becomes a `brainstorm_chunks` row with `role=user`, `mode=conversation`, `model_id=<configured-onnx-embedder-id>` (the embedding model id, NOT the LLM id), `no_decay=1`. Lex's spoken responses become `role=lex` rows.
3. **Audio capture.** Per Wave 2 day 2 step 11 the canonical layout is one `<session_id>.opus` plus a sibling `<session_id>.cues.json` listing turn offsets. The capture rig writes both atomically at session end into `data/brainstorms/bs_2026-05-10_a1b2/audio/`.
4. **Stop.** User clicks Stop (or says "end session", or closes the browser). The 8-step session-end pipeline (Wave 1 day 2 step 20) fires under a session-level lock:
   - Stop accepting new transcript chunks.
   - Drain in-flight transcription jobs.
   - Persist final transcript; set `ended_at`.
   - Force-flush wiki ingest.
   - Pass 2 against the full transcript produces N `wiki_drafts` rows with computed confidence (Appendix H).
   - Refresh rolling session summary; embed into `raw_chunks` with `kind='brainstorm-summary'`.
   - Set `distilled_at`.
   - Release the lock.
5. **Review.** User opens `/drafts`. Sees N pending drafts. Promotes 1, edits 1, discards 1, leaves 1 idle.
   - Promote: `wiki_drafts.status='promoted'`; new file in `wiki/` with `source_brainstorms: [bs_2026-05-10_a1b2]` and `derived_from_brainstorm: true`; commit message `feat(wiki): promote draft from brainstorm bs_2026-05-10_a1b2`.
   - Edit: dashboard editor sends `body_markdown` overrides; promote with edits applied.
   - Discard: `status='discarded'`; `resolved_at` and `resolved_by` set.
   - Idle: after 7 days, auto-promote check (gated off in Wave 1 per section 3.4). After 14 days, auto-drop check fires unconditionally and drops below `DEVNEURAL_DRAFT_AUTO_DROP_THRESHOLD=0.30`.
6. **Future recall.** A future Lex session in `kind='brainstorm'` asks "what was I thinking about X". Intent override fires (`intent='what-was-i-thinking'`). Recall returns brainstorm chunks first, ranked by `cosine + bounded older_boost` (capped at 3.0 per section 4.2). The original brainstorm and any sibling brainstorms surface.
7. **Backup.** Nightly backup at 03:00 local. Session row, chunks, audio bundle, drafts, and the promoted wiki page are all in the snapshot.

### E.2 Meeting session lifecycle (`kind='meeting'`)

1. **Start.** User opens `/sessions/new`, picks `mode='notes'`, fills `meeting_topic="Q2 review with Acme"`, fills `attendees=["Sam Acme","Jordan Beta"]`, leaves `consent_acked=false` (the user has not yet asked attendees on the call). Daemon receives `POST /sessions/new` and inserts: `id=mt_2026-05-10_c3d4`, `project_slug=NULL`, `mode=notes`, `kind=meeting`, `provenance=voice`, `consent_acked=0`, `keep_audio=0`, `started_at=2026-05-10T14:00:00Z`. Response: `{ id, kind:'meeting', capture_state:'awaiting_consent' }`. The dashboard renders the `ConsentGate` component blocking the meeting detail UI until consent is acked.
2. **Pre-consent capture.** whisper.cpp runs in-memory only. Partial transcript chunks may persist to text storage but no audio file is written to disk per the meeting-capture gate (section 3.3).
3. **Consent ack.** User says "everyone okay if I record this for notes?" and clicks "Acknowledge consent". Dashboard POSTs `/sessions/:id/consent { consent_acked: true }`. Daemon sets `consent_acked=1`, `consent_acked_at=<now>`, `consent_acked_by=<auth subject>`. `capture_state` flips to `capturing`. The audio file `mt_2026-05-10_c3d4.opus` plus `mt_2026-05-10_c3d4.cues.json` start being written.
4. **Lex behaviour during the meeting.** Per BF-18 + LX-3 the meeting few-shot loads: listen, summarise, do not interject, do not opine. Per BF-19 + Appendix R.2 #4 the awareness broadcaster is fully silent: no L1 ticks, no L2 push, and `recent_context()` plus `lex_recall()` refuse with `meeting_mode_silenced` if Lex tries to call them. The refusals are daemon-enforced per section 4.3.
5. **Stop.** User clicks Stop. The session-end pipeline runs but takes the meeting branch:
   - Persist final transcript; set `ended_at`.
   - Generate `meeting-summary` artifact (NOT a `wiki-draft`).
   - Extract action items: each becomes a `meeting_action_items` row (section 3.9) with `assignee` mapped to an attendee where possible, `due` parsed where stated. Each action item also seeds a row in the existing reminders table; `meeting_action_items.reminder_id` records the FK.
   - Set `distilled_at`. No `wiki_drafts` row is created.
6. **Review.** User opens `/meetings/[id]`. Sees the summary, action items, audio player with countdown to auto-purge (default 30 days per `DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS`). User can:
   - Mark an action item `done` or `dismissed`.
   - Toggle `keep_audio=1` (the per-session retention override).
   - Click "promote to wiki" if the meeting summary is canonical reference material. That fires `POST /meetings/:id/promote-to-wiki` which creates a `wiki_drafts` row (the FK column is named `brainstorm_id` for compatibility per section 3.4) and follows the normal draft flow. On promotion, the new wiki page sets `source_meetings: [mt_2026-05-10_c3d4]` and `derived_from_meeting: true`.
7. **Audio purge.** On day 31 the daily purge job removes `mt_2026-05-10_c3d4.opus` plus `.cues.json` unless `keep_audio=1`. The transcript and summary remain. `audio_url` flips to null in `MeetingDetailResponse`.
8. **Future recall.** A future Lex session in a brainstorm context asks "what did Sam say about the API timeline". Intent override `'meeting-recall'` fires; recall filters to `kind='meeting'`, ranks by recency-weighted cosine, returns the relevant transcript turns with speaker mapping intact. Meeting-mode silence does NOT apply because the *calling* session is a brainstorm (the gate is on the calling session's kind, not the source data's kind).
9. **Backup.** Nightly backup includes the session row, transcript chunks, action items, summary artifact. Audio bundle is included while it exists; once purged it is gone from new snapshots.

---

## Appendix F: Worked example: curator decision lifecycle

1. **Prompt arrives.** `UserPromptSubmit` hook fires. Daemon receives `{ session_id, prompt_text, project_slug }`.
2. **Recall.** Daemon runs hybrid retrieval. Source-class-weighted scoring. Top candidate: `wiki/connection-pooling.md`, score 0.74, threshold 0.65, source_class `wiki`.
3. **Decision: inject.** `curator_log` row written: `prompt_id=cl_xxx, decision=inject, page_slug=connection-pooling, score=0.74, threshold=0.65, confidence=0.78, source_class=wiki`.
4. **Inject.** Curator returns `<system-reminder>...connection-pooling content...</system-reminder>` to be appended to the prompt. The reminder block also carries a `prompt_id=cl_xxx` correlation token so the dashboard can resolve clicks back to this decision.
5. **Render.** SessionDetail shows the injection in `InjectionRow` with the confidence pill at 0.78 and a "this looks wrong" button.
6. **Follow-up.** User's next turn says "thanks, that worked." Regex classifier: `signal=hit, source=regex-inferred, weight=1.0`. `curator_signal` row written.
7. **Or:** user clicks "this looks wrong" instead. `POST /curator/wrong` writes `signal=wrong, source=user-explicit, weight=10.0`. Page weight drops by 0.10 (configurable). Page flagged for self-audit (`audit_findings.severity='medium'`).
8. **Or:** user clicks the page link in the dashboard. `POST /curator/click` writes `signal=click, source=dashboard-click, weight=1.0`.
9. **Aggregate.** Curator Health card next paint shows updated rates for the day.

Edge cases:

- **Threshold not met.** `decision=silence`, `page_slug=NULL`. No injection, but the silence is logged (so canary failures and silent-failure mode are both detectable).
- **Multiple candidates above threshold.** Currently take top one. Future enhancement: top-K with priority dial.

---

## Appendix G: Domain-distance taxonomy (proposal)

If projects do not yet carry tags (Q-4), Wave 1 day 2 introduces a 5-axis taxonomy. Tags live in `projects.tags` (TEXT JSON array) with values from a controlled list:

| Axis | Values |
|---|---|
| `language` | `ts`, `js`, `python`, `rust`, `go`, `csharp`, `java`, `cpp`, `bash`, `powershell`, `sql`, `html-css`, `mixed`, `other` |
| `runtime` | `node`, `bun`, `deno`, `browser`, `electron`, `python`, `dotnet`, `jvm`, `wasm`, `bare-metal`, `mixed`, `other` |
| `layer` | `frontend`, `backend`, `cli`, `daemon`, `library`, `script`, `infra`, `mixed` |
| `domain` | `dev-tools`, `data`, `ai-ml`, `web-app`, `mobile`, `gaming`, `creative`, `business-app`, `infra`, `mixed`, `other` |
| `lifecycle` | `prototype`, `mvp`, `production`, `legacy`, `archived`, `experiment` |

**Domain-distance** between project A and project B = number of axes on which their tag sets differ (count of axes where `A_axis ∩ B_axis = ∅`).

CP-1 cross-project promotion requires (authoritative):

1. N >= 3 distinct projects share evidence.
2. AND domain-distance between at least one project pair >= 2 (so promotion does not trigger purely from "three Node projects").

Both required. Voice-review.md "OR" wording is superseded by this spec.

**No-tags fallback is a feature flag, not a TODO:**

- Env var: `DEVNEURAL_CROSSPROJECT_FALLBACK_NO_TAGS` (default `block`).
- Values:
  - `block` (default, recommended): if any participating project has no tags, refuse to promote. Surface a reminder asking the user to tag the project. Cross-project verifier never fires for this candidate.
  - `permissive`: fall back to N>=3 with `project_slug != project_slug` only, and log every fallback promotion to a `crossproject_fallback_log` table (created in Wave 2) for retroactive review.
  - `pause`: queue the candidate as `pending-tags` until tags exist; do not promote, do not refuse. Sweeper retries when tags are added.

Wave 1 ships with `block`. The user can switch to `pause` once tagging tooling is in place. `permissive` is documented but discouraged.

---

## Appendix H: Confidence formula for wiki drafts

`wiki_drafts.confidence` is a 0..1 score. Initial heuristic for Wave 1; refined in Wave 3.

```
confidence =
    0.40 * schema_validation_score      // Pass 2 schema fully valid: 1.0; partial: 0.5; invalid: 0.0
  + 0.25 * cosine_similarity_to_wiki    // 1 - max cosine to existing wiki pages (high = novel)
                                        // bounded at [0, 1]; novel content scores higher
  + 0.20 * trigger_clarity              // does the [trigger] section parse clearly per DEVNEURAL.md schema:
                                        //   1.0 trigger present and concrete
                                        //   0.5 trigger present but vague
                                        //   0.0 trigger missing
  + 0.15 * evidence_density             // count of evidence references / target (target=3): clipped to [0,1]
```

Edge cases:

- All-zero score: store as 0.01 to distinguish from null.
- Score >1 (cannot happen with weights summing to 1 and inputs in [0,1]): clamp to 1.0.

Wave 3 refinement: replay against historical promote/discard data, fit a simple logistic regression on the same features, and if the AUC justifies it, replace the heuristic.

---

## Appendix I: Heartbeat watcher service

Two acceptable implementations of the heartbeat target. Pick one in Wave 2.

**Option A: tiny standalone Windows Service.**

- Runs `heartbeat-watcher.exe` on the same host, listening on a different port (e.g. 3748).
- Keeps last-beat timestamp in memory and on disk.
- If no beat in `WATCHER_TIMEOUT_SECONDS` (default 600), fires a Windows toast and posts to a configured webhook (Pushover, ntfy, Telegram, or a phone shortcut endpoint).
- Why on the same host: still proves the daemon process is alive even if the local port is up. Why a separate process: not implicated in a daemon hang.

**Option B: Tailscale-reachable phone shortcut.**

- iOS Shortcut listens on `https://<phone>.tail-XXXX.ts.net/heartbeat`.
- Phone shortcut maintains a local timer; if no beat in 10 minutes, fires a notification.
- Why phone: independent of host entirely; if the host hangs the phone still alarms.
- Why this is harder: shortcut reliability under iOS background restrictions.

**Recommended:** Option A in Wave 2 for simplicity. Add Option B in Wave 3 as a redundant alarm.

The daemon's poster (`07-daemon/src/heartbeat/poster.ts`) is the same in either case; only `DEVNEURAL_HEARTBEAT_URL` differs.

---

## Appendix J: Performance budget

**Reference hardware and corpus profile (assertions are anchored here):**

- Host: Windows 11, single-user developer workstation; CPU >= 8 cores; RAM >= 32 GB; GPU >= 12 GB VRAM (qwen3:8b plus whisper.cpp small model).
- Storage: NVMe SSD; data root on the same drive.
- Corpus: ~5,200 raw chunks, ~120 wiki pages, ~50 brainstorms (Wave 1 baseline). Budgets are valid at ~3x this scale (~16k chunks, ~360 wiki pages, ~150 brainstorms). Beyond that, re-benchmark.
- Network: localhost for daemon; Tailscale tail-net for mobile.

If running on materially weaker hardware (e.g. integrated GPU only, < 8 GB VRAM), divide the budget headroom by the realistic ratio and document deviations in `docs/install/HARDWARE-PROFILE.md`.

| Surface | P50 | P95 | Notes |
|---|---|---|---|
| `UserPromptSubmit` curator decision | 80ms | 200ms | Hard ceiling; if exceeded, daemon must skip injection rather than block the prompt |
| `/lex/recall` simple query | 100ms | 300ms | Hybrid retrieval over current corpus size |
| `/lex/recall` brainstorm-only intent | 80ms | 250ms | Smaller candidate set |
| `/brainstorms` list (50 rows) | 150ms | 400ms | Index-friendly query |
| `/brainstorms/:id` detail (no audio) | 200ms | 600ms | Pulls transcript chunks |
| `/brainstorms/:id/audio` first byte | 200ms | 800ms | Cold disk seek tolerated; range requests required |
| `/drafts` list | 100ms | 300ms | Small table |
| `/curator/wrong` | 50ms | 150ms | Simple update |
| `/stats/curator-health` | 200ms | 600ms | Aggregation; cache 60s server-side |
| `/stats/brainstorm-kpi` | 200ms | 600ms | Same |
| `/stats/outbound` | 100ms | 300ms | Smaller aggregate |
| Pass 2 ingest per chunk | 5s | 30s | Local LLM bound |
| Pass 2 fallback (Anthropic) | 3s | 15s | Network bound |
| Backup snapshot (data root) | 10s | 60s | SQLite atomic capture |

Above these, raise an alert (curator decision exceeding ceiling) or queue (Pass 2 ingest is naturally async).

---

## Appendix K: Concurrency and boot sequence

**Boot sequence on daemon startup:**

1. Load env (`.env.local`, then process env).
2. Resolve data root. Confirm it exists. If not, idempotent setup.
3. Open SQLite. Apply pending migrations (in order, idempotent).
4. Verify schema integrity (PRAGMA integrity_check).
5. Start scheduler (decay, lint, self-audit, canary, schema-regression, raw-chunk-cull, heartbeat poster).
6. Start GPU job queue.
7. Bind HTTP server (default `0.0.0.0:3747`).
8. Start dashboard static serve.
9. Mark `/health` ok=true.
10. Begin processing capture watcher events.

**Concurrency model:**

- Single Node process.
- HTTP requests handled by Node's event loop.
- Long-running work (Pass 2 ingest, embedding, transcription) runs through the GPU queue (single concurrency by default; configurable to 2 if VRAM allows).
- Database access is single-threaded against SQLite (better-sqlite3 or similar synchronous driver). `WITHOUT ROWID` is avoided; WAL mode is on for read concurrency. **Verify on day 1**: confirm WAL is on.
- Voice capture and Lex PTY each run in their own dedicated subprocess; daemon talks to them via stdin/stdout.

---

## Appendix L: Error handling matrix

| Failure | Detection | Action |
|---|---|---|
| Pass 2 schema invalid (local) | Pass 2 wrapper validates JSON | Retry up to 3 times; on Nth failure, if `DEVNEURAL_PASS2_FALLBACK=anthropic` and payload class is not brainstorm-*, call Anthropic Haiku; otherwise mark chunk as `ingest_failed` and surface in dashboard |
| Pass 2 fallback also fails | Wrapper | Mark chunk failed; reminder fired |
| Outbound API daily cap exceeded | Cap check pre-request | Refuse call; log to outbound_log with `response_status=429`, `failure_code='cap-exceeded'`, `error='daily call cap reached'`; reminder fired |
| Outbound attempted with brainstorm payload | Application check + DB trigger | Throw + abort; reminder fired with severity=high; never silent |
| Embedding model mismatch on query | Hybrid scorer | Log warning; degrade to BM25-only for the query; surface "model mismatch, run npm run reindex" reminder |
| Audio file missing | `/brainstorms/:id/audio` handler | 404 with body `{ reason: 'audio_missing', detail: 'expected at <path>' }` |
| Curator latency exceeds ceiling | Wall-clock measurement around recall+rank | Skip injection (`decision=silence` with reason=`timeout`); log; do not block prompt |
| Daemon hang | Watchdog scheduled task /health probe | Restart task fires; if 3 consecutive restarts in 30 min, escalate (toast + heartbeat-watcher already alarmed) |
| Database integrity check fails | Boot sequence | Refuse to start; surface restore instructions in stderr; do not auto-restore |
| Migration fails mid-transaction | Migration runner | Transaction rollback; do not start daemon; surface failed migration name |
| Schema regression suite fails | Nightly task | Reminder; mark stopping criterion S-3 red |
| Canary fails | Nightly task | Reminder; mark Curator Health card canary indicator red |
| Heartbeat poster cannot reach watcher | Poster | Log; back off exponentially; do not crash |

---

## Appendix M: Logging conventions

- All logs are line-delimited JSON to stdout (the daemon's parent task scheduler captures stdout to a rolling file).
- Schema: `{ ts, level, mod, msg, ...context }`.
- Levels: `error`, `warn`, `info`, `debug`. Default level `info`. `debug` enabled by `DEVNEURAL_LOG_LEVEL=debug`.
- Module names match file paths under `07-daemon/src/`.
- Sensitive fields (prompt text, brainstorm body) are NEVER logged at `info` or above. `debug` may include them if the user explicitly opts in via `DEVNEURAL_LOG_PRIVATE=true`.
- Log retention: 30 days rolling at the file level (handled by the scheduler).
- DB observability table retention rules (run as a daily job alongside raw_chunks cull):
  - `curator_log`: retain 365 days. Aggregate older rows into `curator_log_monthly_rollup` (date, decision, count) before deletion.
  - `curator_signal`: retain 180 days. Older rows are aggregated into the same monthly rollup.
  - `outbound_log`: retain 365 days. Always preserved for audit; never aggregated away below daily granularity.
  - `lex_feedback`: retain 730 days (2 years). Older rows aggregated by prompt_version.
  - `audit_findings`: never deleted; finalised findings remain searchable as historical record.
  - `heartbeat_log`: retain 30 days. High-cardinality, low-value beyond recent.
  - `crossproject_fallback_log`: retain 365 days.
  - `backfill_review_queue`: retained until empty + 30 days of `resolved_at` history; then archived.
  - `brainstorm_chunks`: never culled (BF-2 / BF-3).

---

## Appendix N: Build, CI, and nightly jobs

**Per-commit (CI, currently `npm test`):**

- Type check (`tsc --noEmit`).
- Lint (`eslint`).
- Unit tests (`vitest`).
- Integration tests (`vitest tests/integration`).
- Schema migration smoke (apply all migrations against an empty DB and assert idempotency).

**Nightly (scheduled tasks):**

- Backup (existing 03:00).
- Lint (Karpathy steal 2).
- LLM self-audit (Karpathy steal 3).
- Schema regression suite (CI-8).
- Synthetic canary (CI-7).
- Auto-promote / auto-drop pass over `wiki_drafts` (BF-7).
- Raw chunks cull (OP-4).
- Audio compression / age cull if `DEVNEURAL_AUDIO_MAX_AGE_DAYS > 0`.

**Periodic (in-process):**

- Decay (default daily; brainstorms exempt).
- Heartbeat poster (default 60s).
- Wiki repo push (existing 5-min).

---

## Appendix O: Security threat model

In scope:

- **Local data exfiltration:** opt-in flags ship project wiki content to Anthropic. Brainstorm content (raw class AND derived provenance via `contains_brainstorm_source`) forbidden (BF-4). PB-3 rate cap.
- **Prompt injection from external sources:** reference corpus uploads (PDFs, web pages indirectly) could carry adversarial content. Treat reference content as untrusted; never auto-execute or auto-promote-to-wiki without user review.
- **Local file write outside data root:** all writes by daemon are within data root or repo root; verified by integration tests.
- **PIN brute force:** existing PIN auth on dashboard. Add rate limit if not already present (**verify on day 1**).
- **Tailscale exposure:** daemon binds 0.0.0.0:3747 by default. Tailscale ACL is the perimeter. Document in `docs/install/TAILSCALE.md` how to lock down.
- **Audio sensitivity (NEW):** brainstorm audio bundles in `data/brainstorms/<id>/audio/` are higher-blast-radius than transcripts (voice fingerprint, accidental-share risk). Treat as the most sensitive class on disk:
  1. Set folder ACL on the audio root to `Owner:FullControl, everyone-else:None` during install (`docs/install/AUDIO-VIDEO.md` covers).
  2. Default `DEVNEURAL_AUDIO_MAX_AGE_DAYS=0` keeps audio forever. If the user sets a non-zero value, the daily cull job purges (not archives) expired bundles.
  3. Audio bundles are excluded from any outbound code path (already covered by BF-4 + provenance flag).
  4. Backups DO include audio (it is part of the data root); BitLocker / OS-level encryption-at-rest is the perimeter for backup secrecy. Document this trade-off explicitly in `docs/install/RESTORE-DRILL.md`.

Out of scope:

- **Multi-tenant attacks:** single-user system. No cross-user isolation needed.
- **Supply chain on dependencies:** acknowledged but not addressed by this spec.
- **Disk encryption at rest:** delegated to Windows BitLocker / OS-level.

---

## Appendix P: Glossary

| Term | Meaning |
|---|---|
| Brainstorm | A voice-mode Lex session where the user thinks out loud; first-class artifact, never decays, never outbound. |
| Brainstorm chunk | A turn-bounded chunk of a brainstorm transcript stored in `brainstorm_chunks`. |
| Brainstorm summary | Rolling textual summary of a brainstorm session, embedded into `raw_chunks` with `kind='brainstorm-summary'`. |
| Capture | The pipeline that watches Claude Code jsonl and produces chunks. |
| Canary | Synthetic prompt fired nightly that should match a known page; if curator silences it, page is broken. |
| Confidence | 0..1 score on a curator injection or a wiki draft, exposed to the user. |
| Curator | The component that decides at `UserPromptSubmit` whether to inject context and which page. |
| Cross-project promotion | Promoting a wiki page to "global" once it has evidence from multiple projects with adequate domain distance. |
| Decay | Periodic reduction of wiki page weights; brainstorms exempt. |
| Distillation | Pass 2 over a brainstorm transcript producing wiki page candidates. |
| Domain distance | Number of taxonomy axes on which two projects' tag sets differ (Appendix G). |
| Draft | A pending wiki page produced by distillation, awaiting promote/edit/discard. |
| Frozen | Wiki page flag (`frozen: true`) that locks the page from LLM rewrite. |
| Hybrid retrieval | BM25 + vector + recency fused, then weighted by source class. |
| Ingest | Pass 1 + Pass 2 + cross-project + write to wiki. |
| Injection | A snippet appended to a `UserPromptSubmit` prompt as system reminder. |
| Lex | The voice/PTY supervisor; not the same as a worker CC session. |
| Lineage | Wiki page back-pointer to the brainstorm sessions that contributed evidence. |
| Lint | Periodic LLM-driven check for contradictions, stale claims, orphan pages. |
| Outbound | Any code path that sends data off-host. Brainstorms forbidden. |
| Pass 1 / Pass 2 | Two-pass ingest: Pass 1 distills; Pass 2 produces structured wiki page candidates. |
| Recall | Retrieval over the chunk store. |
| Reinforcement | Page-weight movement based on hits, corrections, click-throughs. |
| Self-audit | Periodic fresh-CC-context evaluation of random wiki pages. |
| Source class | Category of a chunk: `brainstorm` / `wiki` / `draft` / `project` / `raw` / `reference`. Drives retrieval weighting. |
| Stopping criteria | The 13 conditions in section 13 that define "Phase Two solid". |
| Wiki | The LLM-maintained markdown collection at `wiki/`. |

---

## Appendix Q: Day-1 startup script for Claude Code

When you (a fresh Claude Code session) read this spec for the first time on Wave 1 day 1, do this in order:

1. Read `voice-review.md` for context (the why).
2. Read this file end to end (the what and how).
3. Answer the open questions Q-1 through Q-20 in section 15 by inspecting the current code. Write the answers into a new file `docs/spec/PHASE-TWO-DAY-1-VERIFICATIONS.md`. Resolve Q-1 (existing migration numbers) BEFORE writing any migration; rename placeholders in a single mechanical pass.
4. Run `npm run backup` and record the snapshot id.
5. Begin Wave 1 day 1 step 1 (foundation migrations), executing in the order listed in section 10.
6. After each migration, run `npm test` and the existing `npm run status` health check.
7. Commit per Appendix B templates after each checkpoint.
8. If you hit ambiguity not resolved by Q-1 through Q-20, stop and write the question into `PHASE-TWO-DAY-1-VERIFICATIONS.md` for the user to answer in the next session. Do not guess at design decisions.

Specifically, you may NOT:

- Change the source-class default weights from those in section 4.2 without the user's say-so.
- Skip the outbound trigger / application check.
- Defer brainstorm KPI tiles or the brainstormer-first README edit; those are identity-defining and must land in Wave 1.
- Add features not specified here.
- Add AI co-author tags to commit messages.

You SHOULD:

- Write tests as you go, not at the end.
- Use TEXT UUID primary keys (Appendix C portability).
- Wrap SQLite-only constructs in clearly-named files so a future Postgres migration is mechanical.
- Keep `voice-review.md` as the rationale ground truth; if you discover a decision conflicts with reality on the ground, update this implementation spec, not `voice-review.md`.

---

## Appendix R: Lex three-level context model and awareness budget (LX-7, LX-8, LX-9)

Lex needs to be conversationally aware without inundation. Three levels of context, each with a hard token budget and a different update mechanism.

### R.1 The three levels

**L1 live awareness** (push, fast). What is happening *right now*: active CC worker sessions, voice mode, PTY state, new reminders since last tick. Updated every 5-15 seconds (default 10s, env `DEVNEURAL_LEX_AWARENESS_INTERVAL_MS`). Token budget: **200 tokens per tick maximum**, summarised if over. Format: tagged `<live_state>...</live_state>` block. Diff-only after the first tick of a session: only deltas relative to the previous tick are emitted, not the full snapshot.

**L2 recent context** (pull-by-default, push-on-change). What has happened *recently* and might matter: artifacts created in the last 24h, open brainstorms, open audit findings, flagged pages, recent thumbs-down turns. Two delivery modes:

- **Pull (primary).** Lex has an explicit `recent_context()` tool (contract in section 4.3). Lex calls it when the conversation suggests the user wants recent state. The daemon does NOT push L2 unsolicited.
- **Push-on-change (exception).** Only when a *user-actionable* event fires. **The actionable event set is closed** and any addition requires updating this appendix:

  | Event | Trigger | Severity | Suppressible by user |
  |---|---|---|---|
  | `audit_finding_high` | new `audit_findings` row with `severity='high'` | high | no |
  | `audit_finding_medium` | new `audit_findings` row with `severity='medium'` | medium | yes |
  | `reminder_due_now` | reminder crosses its due time | medium | per-reminder |
  | `draft_auto_dropped` | a `wiki_drafts` row flips to `auto-dropped` | low | yes |
  | `canary_failure` | nightly canary (CI-7) returns red | high | no |
  | `outbound_cap_hit` | daily outbound cap exhausted | high | no |
  | `heartbeat_missed` | watcher reports >1 missed beat (defence-in-depth; primary alarm is the watcher) | high | no |

  These are tagged `<recent_context kind="actionable" event="<name>">...</recent_context>`. Token budget: **600 tokens per push**, summarised if over per R.2 #1. Anything not on this list MUST NOT be pushed via L2; if a future need arises, the spec is updated first.

**L3 deep memory** (pull only, on demand). The wiki, brainstorms (full transcripts and summaries), reference corpus, project transcripts, all source-classed. Accessed via `/lex/recall` with optional intent override. Token budget: **600 tokens per call** (matches existing curator budget). Lex decides when to call; the system does not auto-inject L3 into the conversation.

**Total awareness overhead per Lex turn (worst case):** 200 (L1) + 600 (L2 push) + 600 (L3 recall) = ~1400 tokens. In the typical case, only L1 fires per tick and L3 fires once per multi-turn arc, so steady-state overhead is 200-300 tokens per turn.

### R.2 Inundation prevention rules

1. **Hard budget.** Per-layer caps above are enforced by the broadcaster. Over-budget content is summarised by a small local LLM call (qwen3:8b, fast path) before emission.

   **1a. Load-shedding under contention.** The summarisation LLM call adds GPU queue pressure exactly when the system is busy. The broadcaster MUST consult the GPU queue (section 11 wave 2 day 1 step 3) before scheduling a summarisation call:
   - If lane 0 (curator) has work pending OR lane 1 (voice transcription) is active, the broadcaster SKIPS this tick's summarisation entirely. It emits a degraded payload: the L1 diff is hard-truncated to the highest-priority changed field plus a `<live_state truncated="true">...</live_state>` marker. L2 actionable pushes that would over-budget are deferred to the next tick (max two-tick deferral; on the third, they are dropped with a counter increment).
   - If lane 2 (Pass 2 ingest) is active but lane 0 and 1 are idle, summarisation runs normally; lane 2 yields per the queue's at-job-boundary preemption.
   - The skip count surfaces in Curator Health as `awareness_summary_skips_per_hour`.

2. **Diff-only L1 after baseline, with revision protocol.** First tick on Lex spawn emits the full state with `revision=1`. Every subsequent tick emits only changed fields tagged with a monotonic `revision=N` and `prev_revision=N-1`. A baseline refresh fires every 30 minutes or on explicit `/lex/snapshot`. **Diff-application rules (Lex-side, enforced by daemon-side guards):**
   - The daemon tracks per-Lex-PTY `last_acked_revision`. Lex acks each diff on receipt by including `lex_awareness_ack=<revision>` in its next emitted turn (the runtime parses this out before the user sees it).
   - If the daemon detects `last_acked_revision != current_revision - 1` when it is about to send a new diff, it forces a full snapshot (`revision=N+1, full=true`) instead of another diff.
   - PTY write failure on a diff: the daemon retries once, then on second failure schedules a forced full snapshot for the next tick and bumps a `awareness_resync_count` counter (surfaces in Curator Health).
   - If the broadcaster's tick is skipped (idle suppression, meeting silence), the next emitted snapshot is full, not a diff against a stale baseline.

3. **Idle suppression.** If the Lex PTY has been idle for >5 minutes (no user input, no Lex output), the broadcaster pauses. Resumes on user activity. Resume emits a full snapshot (per #2).

4. **Per-mode verbosity (daemon-enforced; do not rely on prompt for the silence guarantees).** Each voice mode dictates which layers run AND each awareness path checks `brainstorm_sessions.kind` for the active session before serving:
   - `conversation` (kind=brainstorm): L1 + L2 push-on-change + L3 on demand.
   - `push-to-talk` (kind=brainstorm): L1 only + L3 on demand. L2 push-on-change suppressed at the broadcaster (the user is in tight focus mode); `recent_context()` still callable but filters categories to `['reminders_due']` only.
   - `notes` (kind=meeting, BF-19): all three layers silent at the daemon boundary. The L1 broadcaster does not tick. The L2 push-on-change emitter is short-circuited (events still queue; they fire on session end via a "while you were in the meeting" digest). `recent_context()` and `lex_recall()` both refuse with `meeting_mode_silenced` per section 4.3. Only after the meeting session ends does Lex re-enable normal awareness; the next L1 emission after that is a full snapshot (per #2).

5. **Backpressure metric, with floor and hysteresis.** Per-Lex-turn the daemon tracks `awareness_overhead_ratio = awareness_tokens / max(user_turn_tokens, FLOOR)` where `FLOOR = 200` tokens. The floor prevents short voice acknowledgements ("yes", "ok", "go on") from collapsing the denominator and producing spurious downshifts.
   - **Trip condition.** Rolling-10-turn average of the ratio exceeds `DEVNEURAL_LEX_AWARENESS_BACKPRESSURE_RATIO` (default 0.40). On trip: cut L1 budget to 100 tokens AND suspend L2 push for 5 minutes. Persist trip state to runtime config so a daemon restart preserves it.
   - **Recovery condition (hysteresis).** Rolling-10-turn average of the ratio drops below `0.25` (a hard hysteresis gap of 0.15 below the trip threshold) AND at least 5 minutes have elapsed since trip. On recovery: restore L1 budget to default, re-enable L2 push.
   - **Counters.** `awareness_overhead_ratio`, `awareness_backpressure_trips_per_day`, and `awareness_backpressure_active` all surface in the Curator Health card.
   - **Anti-flap.** A second trip within 10 minutes of recovery doubles the recovery wait to 10 minutes; a third doubles again to 20 minutes; cap at 60 minutes. This prevents the system oscillating during a noisy stretch.

6. **Tagged blocks.** All awareness is wrapped in tags so the model can visually parse what is push vs what is conversation: `<live_state revision="N">`, `<recent_context kind="actionable" event="<name>">`, `<recall>`. Existing Lex prompt convention.

### R.3 How Lex actually gets smarter (LX-9 expanded)

Three independent compounding loops:

| Loop | Mechanism | Cadence | Drives |
|---|---|---|---|
| **Prompt loop** | LX-1 versioning, LX-5 thumbs, LX-6 random artifact sampling, LX-2 A/B replay | months-scale; explicit user labels | per-version prompt tuning |
| **Memory loop** | BF-3 brainstorm chunks (Lex's own past turns persisted as first-class), `/lex/recall` source-classed retrieval | days-scale; automatic | Lex recalls what past Lex said, refining over conversations |
| **Behaviour loop** | LX-3 per-mode few-shot, LX-4 refusal contracts, periodic self-audit (Karpathy steal 3) | weeks-scale; partly automated | Lex's *what to do*, not just *what to say* |

The three feed each other:

```
better prompts -> better artifacts -> better recall material -> better next prompts
       ^                                                              |
       |                                                              v
       +------------------ refusal contract refinements --------------+
```

The loop is intentional and should be observable: weekly review of `lex_feedback` aggregates per `SYSTEM_PROMPT_VERSION` is the canonical signal that the loops are working. If thumb-up rate trends up over months, the loops are compounding. If flat or down, retune.

### R.4 Implementation checklist (overlay onto Wave 2 day 5 / Wave 3)

- [ ] L1 broadcaster with diff-only state, 200-token budget, idle suppression. (Wave 3 day 3 with the gate check.)
- [ ] L2 `recent_context()` tool exposed to Lex. (Wave 2 day 5.)
- [ ] L2 push-on-change for actionable events only. (Wave 2 day 5.)
- [ ] L3 already wired via `/lex/recall` (Wave 1).
- [ ] Per-mode verbosity rules enforced. (Wave 2 day 5.)
- [ ] Backpressure metric in Curator Health. (Wave 2 day 4 polish.)
- [ ] Meeting mode: all awareness silent. (Wave 2 day 5.)

---

End of spec. Hand this file plus `voice-review.md` to a Claude Code session at the start of Wave 1; the session should be able to execute Wave 1 day 1 unattended once Q-1 through Q-20 are answered. Total spec length intentionally extensive: this is a "drop and start" document, not a sketch.
