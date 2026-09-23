# Lex Autonomy Payload Spec: Cold-Start + Worker Boot

**Status:** draft, ready for implementation
**Author:** Lex (DevNeural brainstorm session 2026-05-24)
**Goal:** End-to-end loop where Lex restarts AND worker /clear/spawn both inherit a complete, fresh, source-of-truth payload derived from the brainstorm corpus. No silent context loss. No stale distillations. No worker booting blind.
**Codex peer review:** attempted, blocked by 401 invalid API key. To re-run when key fixed. Spec proceeds on internal audit only; flag for external sanity check before any irreversible schema migration.

**Sister spec:** `docs/spec/LEX-STANDALONE-SUPERVISION.md`. That spec defines WHEN Lex grooms and refreshes the data this spec ASSEMBLES on boot. Supervision's idle-watcher passes (T+5/20/60min, T+6h day-cap) write the `last_summary`, brainstorm_chunks rollups, and HANDOVER artifacts that this spec's cold-start preload + worker boot payload reads. Read both together; do not implement payload assembly without confirming the supervision write-path produces the inputs it expects.

**Gating:** Stages 5-12 of this spec (post Stage 0-2 smoke) are the formal "Lex autonomy" milestone. They ship AFTER the Stage 0-2 smoke test passes per `TODO.md` "Next after Stage 0-2 smoke" section. Do not begin Stages 5-12 until the smoke is green and the supervision idle-watcher is producing fresh inputs for at least one full day-cycle.

---

## 1. End-state behavior contract

### Lex cold-start (Lex's own session restart)
On boot, Lex's SessionStart hook delivers a payload that is correct OR explicitly flagged stale. Lex's first spoken line is one of:

- "Caught up. Resuming X." (fresh payload)
- "Give me a sec, distillation in flight." (sync barrier waiting)
- "Stale context, T minutes old. Last verified state was X. Want me to walk back further?" (degraded mode)

Never silent acceptance of a stale or missing payload.

### Worker boot / smart-clear
On worker /clear or fresh worker spawn against a brainstorm anchor, the daemon writes a payload to the worker's terminal that contains the full brainstorm context required to operate. Worker boots already knowing:

- Project goal + acceptance criteria
- Current phase / where we are
- Outstanding decisions Lex flagged open
- Last directive Lex gave the worker (or "first attach")
- Recent verbatim brainstorm excerpts relevant to next-actions
- Pointer file paths for full transcripts if worker needs to read more

Works identically whether worker existed before or this is first attach against a brainstorm that has been running solo.

---

## 2. Answers to the 10 architectural questions

### Q1: Schema — add cc_session_id to brainstorm_chunks?

**Yes, add it.** Per-session attribution at the row level is non-negotiable for clean distillation scoping. The alternative (created_at + session window) requires every consumer to JOIN against lex_transcript_ref and is fragile against clock drift / out-of-order ingestion.

- Migration: ALTER TABLE brainstorm_chunks ADD COLUMN cc_session_id TEXT (nullable for historical rows).
- Index: CREATE INDEX idx_brainstorm_chunks_session ON brainstorm_chunks(brainstorm_id, cc_session_id, turn_index).
- Write path: brainstorm-jsonl-ingestor and lex-voice-ws both stamp the originating cc_session_id at insert time. NULL for direct-llm (no CC session bound).
- Backfill: historical rows stay NULL. Distillation falls back to anchor-flat behavior when all relevant rows are NULL (i.e., legacy data).

### Q2: Per-session distillation storage

**Both.** Per-CC-session summary lives on lex_transcript_ref (one column: ref_summary TEXT, ref_summary_ms INTEGER). Anchor-level last_summary stays as a rolling aggregate that's regenerated from the N most recent ref_summaries on each session-end.

- Per-ref summary is canonical for that ended session and immutable after write.
- Anchor last_summary is a derived field, refreshed on every session-end.
- Cold-start preamble pulls per-ref summaries (newest-first, up to budget) AND the anchor aggregate as a project-state header.

### Q3: Adaptive walk-back algorithm

Signal: total token count of preloaded payload after assembling the first session.

- Target floor: 1500 tokens of structured signal (excludes raw verbatim).
- If first session preload < floor, pull next sibling. Repeat.
- Hard ceiling: 5 sessions OR 6000 tokens of structured signal, whichever first.
- Also escalate depth if first session has < 8 turn pairs (likely interrupted/aborted) OR has no "Key decisions" / "Planted markers" content in its distillation.
- Termination guarantee: if 5 sessions still under floor, surface "thin context" warning to Lex (he says it aloud) rather than pulling forever.

### Q4: Lex-chunk capture invariant

**Hard write-path guarantee. Not a backfill.** lex-voice-ws.ts MUST write Lex assistant turns to brainstorm_chunks regardless of worker attachment state. Per user's standing rule: attachment is additive, never a gate.

- Audit lex-voice-ws.ts lines around 823 (assistant-text) and 1169/1224 (chunk-write branches). Remove any conditional on attached_worker_session_id, attached_pty, project_session existence.
- Add a write-side invariant test: synthetic brainstorm with worker attached, assert N Lex turns produce N brainstorm_chunks rows with role='lex'.
- Backfill exists ONLY as historical-data rescue, never as a substitute for live capture.

### Q5: Worker boot payload composition

Layered, in this exact order in the injected text:

```
<lex-handoff>
## Project
{project_name} — {goal_one_liner}

## Current phase
{phase_id}: {phase_name}
Where we are: {current_position_one_paragraph}

## Acceptance criteria for current phase
- {criterion 1}
- {criterion 2}
- ...

## Outstanding decisions (Lex flagged open)
- {decision_id}: {one_line_question_or_blocker}
- ...

## Last directive from Lex
{verbatim_text_of_last_inject_or_"FIRST-ATTACH"}

## Last worker activity
{one_line_summary} (jsonl ref: {sha8})

## Recent brainstorm context
{N verbatim excerpts, tagged by relevance to next-actions, each ≤ 200 chars}

## Full brainstorm transcript pointers
- Latest session: {jsonl_path}
- Distillations: see brainstorm_chunks for brainstorm_id={anchor_id}
- Spec docs: {project_root}/docs/spec/

## Operating rules
You are the worker. Lex is the authority and tracks state. Confirm receipt by acknowledging the directive and stating your first action. If anything in this payload is ambiguous, ask Lex (voice channel) before acting.
</lex-handoff>
```

Budget: ~2500 tokens total. Verbatim chunks are selective, not bulk. Worker has pointers to the rest.

### Q6: Sync barrier on cold start

**Block with timeout. User opted in.** Cold-start preload waits up to 30s for any in-flight session-end distillation against the anchor to complete. While waiting, Lex's first spoken line is "Give me a sec to catch up."

- If distillation completes within 30s, payload is fresh. Lex says "Caught up. Resuming X."
- If timeout hits, payload uses best-available + flag stale. Lex says "Stale context, T minutes old."
- Lex never silently uses stale data.

### Q7: Failure signaling

Three surfaces, all required:

1. **Cold-start preamble field:** payload includes a `freshness` block with status (fresh / stale / failed), age_ms, source (live-distill / backfill / handover-doc), and reason if degraded. Lex MUST verbalize the status if not fresh.
2. **Dashboard header pill:** brainstorm UI shows a freshness pill (green/yellow/red) reading the same source. Click expands to event log.
3. **Open-reminder escalation:** after 2 consecutive distillation failures (matches existing spec line 49 LEX-STANDALONE-SUPERVISION.md), insert an open_reminder with priority=high. Surfaces in Lex's UserPromptSubmit live_state.

### Q8: Anchor scoping

Anchor + label is insufficient. Add explicit `project_scope_id` to brainstorm_sessions (foreign key to a projects table, NULL for general/free brainstorms). Preload filters by (label match AND same project_scope_id) OR (label match AND both NULL).

- DevNeural-project brainstorms never bleed into a separate Wiki brainstorm even if labels overlap.
- Free-brainstorms (no project) only see other free-brainstorms.
- Migration: add project_scope_id column (nullable), populate retroactively where label clearly maps to a known project; leave NULL otherwise.

### Q9: Autonomy + brainstorm-completeness gate

Lex maintains a brainstorm-completeness checklist per active project. Required fields before Lex will hand off to worker:

- **Goal:** one sentence, user-confirmed
- **Acceptance criteria:** at least 1 explicit, user-confirmed
- **Phase ordering:** at least 1 phase with first task identified
- **Risks acknowledged:** at least 1, or explicit "none flagged"
- **Open questions resolved or parked:** none in unresolved state at handoff time

Implementation: Lex runs a self-query against the brainstorm corpus at handoff request. If any required field is missing, Lex blocks handoff and asks user the specific missing question. Conversational, not a form. The checklist is a Lex-internal data structure; user never sees the form, only the questions.

Stored in brainstorm_chunks with kind='plan-checklist' for retrieval.

### Q10: Order of operations (the critical sequence)

This is the dependency chain. Skip an earlier step and later steps are built on sand.

**Stage 0 (foundation, no-half-states):**
1. Add cc_session_id column to brainstorm_chunks (nullable, no consumer changes yet). Ship.
2. Stamp cc_session_id at insert time in jsonl-ingestor and lex-voice-ws. Ship. Verify with a smoke test.
3. Add ref_summary + ref_summary_ms columns to lex_transcript_ref. Ship.

**Stage 1 (capture invariant):**
4. Remove any worker-attachment gate from Lex chunk-write paths in lex-voice-ws.ts. Add the write-side invariant test (worker-attached session must still produce role='lex' chunks). Ship.
5. Verify against current bug 2026-05-24 repro: end an attached session, confirm chunks land.

**Stage 2 (per-session distillation):**
6. Refactor distillation-generator.ts to take a (brainstorm_id, cc_session_id) tuple and pull chunks scoped to that session, ordered DESC by turn_index, then chronological for prompt assembly.
7. Session-end-pipeline writes the result to lex_transcript_ref.ref_summary.
8. Rolling aggregate: regenerate brainstorm_sessions.last_summary from the N most recent ref_summaries. Ship.

**Stage 3 (sync barrier + freshness signaling):**
9. Cold-start preload awaits in-flight session-end distillation up to 30s.
10. Preload event log records freshness status. Cold-start preamble includes freshness block.
11. Dashboard pill reads the same source. Ship.

**Stage 4 (adaptive walk-back):**
12. Implement Q3 algorithm in lex-cold-start-preamble.ts. Token-counting + depth-escalation + ceiling. Ship.

**Stage 5 (worker boot payload):**
13. Build the layered handoff document (Q5 shape) as a daemon-generated text block.
14. Smart-clear v3 (or v2 extension) replaces resume-summary with this layered payload.
15. First-attach path: when worker spawns against an anchor that has no prior worker, daemon assembles the same payload. Worker boot blind never happens. Ship.

**Stage 6 (scope hygiene):**
16. Add project_scope_id to brainstorm_sessions, populate retroactively where labels map. Update preload filter. Ship.

**Stage 7 (overnight + escalation wiring):**
17. Wire the 2-consecutive-failure escalation. Wire parked-decision morning-brief assembly. Wire HANDOVER vs last_summary timestamp compare in cold-start. Ship.

**Stage 8 (brainstorm-completeness gate):**
18. Implement Q9 checklist + self-query at handoff request. Ship.

Each stage leaves the system in a strictly-better state. No half-broken intermediate. Stage 0-2 closes the open bug 2026-05-24 specifically; stage 3+ closes the broader payload requirements.

---

## 3. Things we missed in the original audit (uncovered while writing this spec)

- **Concurrent worker sessions on one anchor.** Per-session cc_session_id resolves this for chunk attribution and per-ref distillation, but Q5's "last worker activity" needs to be defined for multi-worker. Recommend: surface the most recently active CC session's tail; explicitly mark if multiple workers are bound.
- **brainstorm_chunks DELETE on row purge.** Stage 2's regenerated last_summary depends on stable ref_summaries. If a transcript_ref row gets reaped (purge old refs), ref_summary disappears with it. Decide: preserve ref_summary as a denormalized copy on brainstorm_sessions.history JSON column, OR refuse to reap refs that have a non-null ref_summary. Recommend the latter (immutable summary = immutable ref row).
- **Cold-start preload during a live brainstorm.** Today's preload assumes the new session is the boot. If user opens a brainstorm tab while another tab is mid-conversation on the same anchor, do both tabs run preload? Race against in-flight session-end. Define: preload is per-tab idempotent, anchor-level state writes are last-writer-wins with a daemon-side mutex (already partially specced via withSessionEndLock).
- **Voice mode disclosure of staleness without overrunning brevity rules.** Q7's "Lex must verbalize freshness if not fresh" needs a phrase budget. Spec: max 12 words for the freshness line, no telemetry vocabulary. Examples allowed: "Stale context, twenty minutes old, want me to walk back further?"

---

## 4. Where current design is fundamentally wrong (not just incomplete)

- **Anchor-flat distillation.** Current scheme sums ALL chunks under an anchor into one last_summary. This is structurally incapable of tracking topic shifts across sessions. Fix: per-session distillation (Q2). Not a tweak; it's a model change.
- **Worker boot payload as "best-effort summary from spec/git/jsonl tail."** Wrong source of truth. The brainstorm corpus IS the source. Worker must be projected FROM brainstorm corpus, not reconstructed FROM artifacts. Fix: Stage 5.
- **Lex chunk capture gated on worker attachment.** Violates the user's explicit invariant. Fix: Stage 1.
- **Silent stale serving.** No mechanism today refuses to serve a stale payload or signals it. Cold-start lies by omission. Fix: Stages 3 + 7.

---

## 5. Open items requiring user confirmation before stage 0 begins

- Token budget targets (1500 floor / 6000 ceiling / 2500 worker-boot) — these are my guesses, user may want different.
- Project_scope_id semantics (one project per scope, or hierarchical with milestones?).
- Whether brainstorm-completeness gate (Q9) is opt-in per project or always on.
- Codex review: re-run with valid API key before any irreversible migration ships. None of stages 0-2 are irreversible (additive columns), so stages can start while codex review pends.

---

## 6. Codex external review v1 (2026-05-25, gpt-5.3-codex)

Codex reviewed the full prompt + this spec's draft answers. Below are codex's deltas vs my originals. Where codex disagrees, codex wins unless flagged otherwise.

### Non-negotiables codex enforces (adopt verbatim)
1. Brainstorm data is the source of truth; worker state is derivative.
2. Lex chunk capture must be write-through and attachment-independent.
3. Every derived artifact carries `as_of` timestamps and source coverage metadata.
4. Never silently serve stale distillation; stale/failure must be explicit.

### Codex confirms (agrees with my Q1-Q4, Q6-Q8)
- Q1 cc_session_id: add it. Anchor-flat is brittle for concurrent sessions, retries, backfills.
- Q2 per-session summary storage: both. Per-session immutable + anchor-level rolling aggregate built FROM per-session rows.
- Q4 write-path invariant: hard guarantee in lex-voice-ws. Backfill secondary only.
- Q7 failure signaling: three surfaces simultaneously (pill + preamble + persistent reminder).
- Q8 project_scope_id required; label-only matching is fundamentally wrong.

### Codex tightens (replace my answers with these)

**Q3 adaptive walk-back:** bounded multi-signal, not a single token threshold. Coverage gates per session bundle: tokens >= floor AND decisions >= floor AND open-items present AND last-directive present. If any gate fails, include previous bundle and re-check. Cap at N=6 sessions or token cap, whichever first. If still insufficient, return `insufficient_context=true` and ask user to confirm/backfill.

**Q5 worker boot payload composition (replaces my 5-layer with codex's 7-layer):**
1. `project_state_header` — goal, current phase, active branch/workspace, blockers.
2. `execution_contract` — acceptance criteria, constraints, non-goals, definition of done.
3. `open_arcs` — prioritized, owner, next action, dependency.
4. `decision_log` — final decisions + parked decisions + deadlines.
5. `handoff_context` — Lex last directive, last worker activity, why it stopped.
6. `evidence_pack` — selective verbatim chunks mapped to each open arc.
7. `freshness` block — `as_of`, distillation status, missing fields.

First-attach: same builder, `last_worker_activity=null`.

**Q6 sync barrier timeout:** 8-15s, not 30s. Wait for correctness but never hang forever. Timeout marks `distillation_pending=true` on the payload.

**Q9 loose-ends gate (codex expands my checklist):**
1. Goal/outcome.
2. Acceptance criteria (testable).
3. Ordered milestones.
4. Dependencies and external prerequisites.
5. Risks + mitigations.
6. Open decisions with owner + due trigger.
7. Execution constraints (time, tooling, guardrails).

Lex collects conversationally, handoff blocked until schema completeness passes. Not optional for full autonomy.

### Codex new items I missed

1. **Idempotency keys** on chunk writes and distillation jobs. Prevents duplicate rows on reconnect/retry.
2. **Monotonic sequence numbers** per session for deterministic replay. Add `seq_no INTEGER NOT NULL` to brainstorm_chunks scoped by (brainstorm_id, cc_session_id).
3. **Provenance fields on summaries:** `source_chunk_count`, `source_session_ids` (array), `coverage_score`. Without these, summaries are unauditable.
4. **Contract tests for four scenarios:** first-attach, worker-attached, restart-race, concurrent-session. Each scenario gets a fixture + assertion of payload correctness.
5. **"Rebuild from raw chunks" admin endpoint:** lets an operator regenerate aggregates from primary chunk store when derived data corrupts. POST /lex/rebuild-summaries?brainstorm_id=X.
6. **Strict nullability policy:** distinguish `unknown` vs `none` vs `not_applicable` in payload fields. Use explicit string enums, not nullable.

### Codex's order-of-operations (replaces my Stage 0-8)

Note: my spec ordering put cc_session_id schema BEFORE write-path. Codex's order puts write-path FIRST. Worker has already shipped my Stage 0 (additive nullable schema, fully reversible) so the reordering applies to remaining stages only. Stage 1 (write-path) is correctly next.

1. Fix write-path invariant: Lex chunks always persist (attachment-independent). **← worker starts here**
2. Add cc_session_id to chunks and wire capture. **← already shipped (a0eb4c0)**
3. Add per-session distillation table + pipeline scoped by cc_session_id.
4. Fix distillation query ordering/scoping bug; stop summarizing oldest 50 globally.
5. Add sync barrier + freshness metadata in cold-start preload.
6. Add explicit stale/failure surfacing (UI + payload + reminder).
7. Implement adaptive walk-back over session bundles.
8. Build deterministic worker boot payload builder from same source graph.
9. Add first-attach path using identical builder (worker fields nullable).
10. Enforce loose-ends handoff gate in Lex before worker start.
11. Add grooming/escalation wiring + freshest artifact compare.
12. Tighten scope with project_scope_id; kill label-only sibling preload.

Codex warning: do not ship 5-9 before 1-4. Otherwise we formalize stale garbage.

### Codex's fundamentally-wrong list (matches mine)
- Label-based preload scoping.
- Anchor-only rolling summary as sole truth.
- Conditional Lex chunk persistence.

### Codex's incomplete list (matches mine)
- Adaptive walk-back heuristics.
- Failure surfacing.
- First-attach worker path.
- Escalation wiring.
- Grooming assembly.
