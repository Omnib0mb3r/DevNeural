# Codex review 001 of Phase Two implementation spec

> Captured 2026-05-10 during the Phase Two planning session. Codex (OpenAI) was given context about DevNeural and asked to review `voice-review.md` and `docs/spec/PHASE-TWO-IMPLEMENTATION.md` with the same rigour as a senior reviewer.
>
> Codex's verdict: "Execute with edits, not as-is."
>
> All critical and important findings have been adopted into `PHASE-TWO-IMPLEMENTATION.md` (revision dated 2026-05-10 evening). This file preserves the original review for traceability.

## A. Critical issues (all adopted)

1. **`curator_signal` FK invalid in SQLite.** `prompt_id` referenced `curator_log(prompt_id)` but parent column was not `UNIQUE` or `PK`. **Fix adopted:** added `UNIQUE` constraint on `curator_log.prompt_id`; FK in `curator_signal` now references `curator_log(id)`; `prompt_id` retained as a non-key correlation field.

2. **Outbound privacy guard incomplete.** Trigger only blocked `payload_class LIKE 'brainstorm-%'`. A wiki page derived from a brainstorm could slip through. **Fix adopted:** added `contains_brainstorm_source` provenance column; application checks plus DB trigger now block both class AND provenance; cross-project verifier rejects pages with non-empty `source_brainstorms` before reaching outbound layer.

3. **Auto-promotion of drafts unsafe.** Confidence formula rewards novelty; auto-promote at 7 days would pollute the wiki. **Fix adopted:** auto-promote disabled in Wave 1; only auto-drop runs. `DEVNEURAL_DRAFT_AUTO_PROMOTE_ENABLED` defaults `false`; flag stays off until Wave 3 logistic-regression calibration on labeled history exists.

4. **Lineage KPI denominator wrong.** Metric understated and incentivised fake tagging. **Fix adopted:** added `derived_from_brainstorm` boolean per page; denominator is now pages where `derived_from_brainstorm=true`, not all pages.

5. **Hardcoded migration numbers contradicted Q-1.** Filenames `001-009` were hardcoded while Q-1 said "discover next number from existing repo." **Fix adopted:** filenames replaced with placeholders `P2-W1-D1-001` through `P2-W1-D1-009`; spec now requires a single mechanical pass on day 1 that resolves placeholders to concrete numbers per the existing migration runner. Wave 2 and Wave 3 use parallel placeholder schemes.

6. **`POST /drafts/:id/promote` conflict semantics undefined.** **Fix adopted:** all four conflict cases now specified: slug collision (fail-closed default with merge-suggest opt-in), target frozen (absolute refusal), superseded race (first wins, second auto-marked superseded), target drift (optimistic concurrency via `expected_target_version`).

## B. Important issues (all adopted)

1. **`/curator/hit` vs `/curator/click` endpoint mismatch.** **Fix adopted:** canonical name is `/curator/click` everywhere.

2. **N=3 OR vs AND domain-distance contradiction.** **Fix adopted:** spec authoritative as `N=3 AND domain-distance`. Voice-review.md "OR" wording is superseded. No-tags fallback promoted to a feature flag (`DEVNEURAL_CROSSPROJECT_FALLBACK_NO_TAGS=block|permissive|pause`, default `block`).

3. **`last_verified` backfill destroyed staleness signal.** **Fix adopted:** legacy pages backfilled with `null`, treated as `verification_unknown`; new low-severity lint flag for first-time verification, separate from the 90-day stale flag.

4. **`audio_path` absolute conflicted with relocatable data root.** **Fix adopted:** column documented as data-root-relative; never absolute.

5. **`exp(+age_days/90)` unbounded.** **Fix adopted:** replaced with `older_boost = min(1 + (age_days / 90), 3.0)`; spec forbids unbounded variants.

6. **`response_status=429-internal` type error in INTEGER column.** **Fix adopted:** added `failure_code TEXT` column to `outbound_log`; `response_status` stays integer; failure conditions encoded in `failure_code` and `error`.

## C. Nice-to-haves (all adopted in this revision)

1. **Source-class mapping for brainstorm summary vs full brainstorm chunks.** Section 4.2 default weights now treat both as `brainstorm` source class with the same weight. Implementation note added so ranking does not drift across implementations.

2. **Latency budget hardware profile.** Appendix J now anchors budgets to a reference hardware + corpus profile. Deviations documented in `docs/install/HARDWARE-PROFILE.md`.

3. **Retention rules for `curator_log`, `curator_signal`, `outbound_log`, `lex_feedback`.** Appendix M now lists per-table retention with rollup and cull strategies.

4. **Audio storage canonicalisation.** Wave 2 day 2 specifies one `<session_id>.opus` (or `.wav`) plus a sibling `<session_id>.cues.json` with turn offsets. Earlier "per utterance OR continuous" wording removed.

## D. Things Codex agreed the plan got right

- Brainstorm-first reframe propagated consistently across retrieval, privacy, retention, UI.
- Gating awareness broadcaster behind curator observability.
- `model_id` + `reindex`, outbound logging, schema regression as foundational moves.
- Wave structure respects dependency order.

## E. Under-addressed risks (now addressed)

- **Backfill provenance risk:** Wave 2 day 3 introduces `backfill_review_queue` with bands (high/borderline/low) plus a `derived_from_brainstorm` set-only-if-cosine-very-high heuristic to prevent fake lineage hardening.
- **Session-end race:** Wave 1 day 2 step 20 specifies a session-level lock plus an exact 8-step ordering for the session-end pipeline.
- **Audio sensitivity:** Appendix O now covers folder ACL, retention default, outbound exclusion, and BitLocker-as-perimeter for backups.
- **GPU starvation:** Wave 2 day 1 GPU job queue specifies priority lanes 0-3 with at-job-boundary preemption protecting curator path latency.
- **Cross-project no-tags fallback:** now a configurable feature flag rather than an implicit permissive fallback.

## F. Holes in the spec for an unattended CC session

- **Q-1 through Q-12 list expanded** to cover stack assumptions, scheduler shape, audio bundle format, WAL mode, and auth details that were previously implicit. (Updated in section 15.)
- **`audit_findings`, `heartbeat_log`, `brainstorm_edges`, `crossproject_fallback_log`, `backfill_review_queue`** all now have full DDL up front in the migrations of the wave that introduces them.
- **Backfill manual review queue** now has full schema (`backfill_review_queue` table) plus UI (`/brainstorms/backfill-review` route) plus stop condition (queue empty OR user-dismissed).
- **Schema regression and canary fixture generation** now have explicit procedures in section 9.5 and 9.6.
- **Worked-example error fixed:** Appendix E now correctly notes `model_id` is the embedder id, not the LLM id.
- **Migration directory creation latitude removed:** the agent must integrate with the existing runner per protocol step 1 of section 3; no choose-your-own-adventure on schema-critical paths.

## G. Codex verdict (verbatim)

> "Execute with edits, not as-is. The plan is directionally solid, but the current spec still has schema-level errors, privacy invariant gaps, and write-path ambiguities that make an unattended implementation session too likely to guess wrong. Priority order: fix the `curator_signal` foreign key and the outbound provenance invariant; disable or postpone auto-promotion and define draft-promotion conflict behavior; correct the lineage KPI denominator; make the migration plan executable against the real repo instead of hardcoded `001-009`; then clean up the endpoint and cross-project-rule contradictions. After those edits, this is fit for execution."

All priority-order edits adopted in this revision.

---

End of Codex review 001. Next planned external review: after Wave 1 day 3, before Wave 2 begins.
