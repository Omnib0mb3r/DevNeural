# Handover: Phase Two Wave 1 day 1 (2026-05-10)

> Pick up here for Phase Two Wave 1 **day 2**. Day 1 is fully shipped on the `phase-two` branch.
>
> Worktree: `C:/dev/Projects/DevNeural-phase-two/`. Branch: `phase-two`. Master is untouched and remains the live daemon's branch.
>
> Read order for the new session:
>
> 1. This file (you are here).
> 2. `docs/spec/PHASE-TWO-IMPLEMENTATION.md` (the plan, post-CODEX-002 adoption, post-mechanical-rename).
> 3. `docs/spec/CODEX-REVIEW-001.md` and `docs/spec/CODEX-REVIEW-002.md` (what was corrected and why).
> 4. `docs/spec/PHASE-TWO-DAY-1-VERIFICATIONS.md` (Q-1 through Q-20 with file:line evidence).
> 5. `voice-review.md` (rationale ground truth).

## TL;DR

- Wave 1 day 1 done: migrations + runner + daemon-boot wiring + tests. 58 of 58 tests green. tsc clean.
- Day 2 (code wiring) is up next. 8 substantive code edits. File-path map below; do not trust the spec's file paths verbatim.
- Day 2 step 20 (session-end pipeline 8-step ordered flush + wiki_drafts write) is the keystone work; do it last and put the most care into it.
- Live daemon on master is unaffected; migrations apply at next daemon boot from this branch.

## Commits landed this session (most recent last)

```
8e29662 docs(spec): Phase Two implementation spec, voice review, Codex review 001    (master)
df1c442 docs(spec): Codex review 002 of Phase Two implementation spec                (master)
7444f25 docs(spec): adopt CODEX-REVIEW-002 findings B1-B9                            (master)
f71b955 chore(spec): day-1 verifications + migration filename mechanical pass        (phase-two)
38f96fe chore(db): phase two migrations 001-009                                      (phase-two)
b8c7127 chore(daemon): wire migration runner into boot sequence                      (phase-two)
```

The first three are on master and shared with the executor session. The last three are on the `phase-two` branch only.

## What day 1 delivered

### Adversarial review and adoption (on master)

- `docs/spec/CODEX-REVIEW-002.md` written by external Codex CLI (~5 min cost). Verdict: "Execute with edits." 0 critical, 9 important, 3 nice-to-have.
- All 9 important findings (B1-B9) folded into `PHASE-TWO-IMPLEMENTATION.md` plus risk E4 and nice-to-have C3. C1 and C2 deferred to a later cleanup pass.

### Day-1 verifications (on phase-two)

- `docs/spec/PHASE-TWO-DAY-1-VERIFICATIONS.md` answers all 20 open questions with file:line evidence.
- Critical findings: no migration runner exists, no migrations directory exists, no `07-daemon/src/db/`. Created during day 1.
- Existing `brainstorm_sessions` table does NOT carry `project_slug` (uses `cwd` + `pty_id` + `claude_session_id`). Migration 004 added `project_slug` as a new nullable column.
- WAL mode confirmed on. Auth cookie is `dn_session` with rate-limiting in place. NVIDIA-SMI on PATH. Wiki frontmatter parser tolerates unknown fields (sweep migration safe).

### Migration runner and migrations (on phase-two)

- `07-daemon/src/db/migrate.ts`: minimal versioned runner. Reads `scripts/migrations/*.{sql,ts}` in lex order, applies each inside a transaction, records applied filenames in a `_migrations` table. Idempotent. CLI: `npx tsx src/db/migrate.ts <dbPath> <migrationsDir>`.
- Runner wired into `daemon.ts` boot after `Store.open()` and before HTTP bind.
- Nine migrations under `07-daemon/scripts/migrations/`:
  - `001-schema-version-meta.sql` (WI-1)
  - `002-add-model-id.sql` (EM-1; backfill placeholder `__BACKFILL_PENDING__`, real value to be filled by day 2)
  - `003-brainstorm-chunks.sql` (BF-3)
  - `004-brainstorm-sessions-deltas.sql` (BF-6, BF-11, BF-14, BF-17, plus CODEX-002 B5 columns: `consent_acked_at`, `consent_acked_by`, `keep_audio`, `provenance`)
  - `005-wiki-drafts.sql` (BF-7; FK column historical name kept per CODEX-002 B4)
  - `006-outbound-log.sql` (PB-2; trigger blocks `brainstorm-*`, `meeting-*`, and `contains_voice_session_source=1`)
  - `007-curator-log.sql` (CI-1, CI-2; UNIQUE prompt_id)
  - `008-lex-feedback.sql` (LX-5)
  - `009-wiki-frontmatter-sweep.ts` (WI-1, WI-2, WI-3, WI-4; non-clobbering)
- Tests: `07-daemon/tests/migrations/runner.test.ts` (5 cases). Full suite 58 of 58.
- Validation: applied successfully against `C:/dev/backups/skill-connections/2026-05-10T02-54-39/sqlite/index.db` (a copy of live), and against `files/wiki/` (173 pages updated, idempotent re-run is no-op).

### Mechanical placeholder rename (on phase-two)

- `P2-W1-D1-`, `P2-W2-D1-`, `P2-W3-D1-` prefixes stripped from `docs/spec/PHASE-TWO-IMPLEMENTATION.md`. 36 occurrences resolved in one sweep. Filenames are now `001-` through `014-` style.
- This change is on `phase-two` only; master keeps the original placeholder spec for traceability.

## Wave 1 day 1 sign-off checklist (per spec section 10)

- [x] All migrations 001-009 applied; data root validated. (Validated against backup copy at `C:/dev/backups/skill-connections/2026-05-10T02-54-39`.)
- [x] `npm test` green (58 of 58).
- [ ] New integration tests green: brainstorm.int, curator.int. **(Day 3 deliverables, not day 1.)**
- [ ] Schema regression suite runs and passes against a baseline. **(Day 3.)**
- [ ] Curator Health card renders on the dashboard with non-zero data after 24 hours. **(Day 3.)**
- [ ] Brainstorm KPI tiles render with correct counts. **(Day 3.)**
- [ ] Outbound card renders; brainstorm-outbound-count shows 0. **(Day 3.)**
- [ ] Outbound log captures at least one Pass 2 fallback or verifier call (induce one in test mode). **(Day 3.)**
- [ ] Privacy regression test passes (BF-4 brainstorm forbidden assertion). **(Day 3 — but the trigger-level test in runner.test.ts already covers the DB-side invariant.)**
- [ ] README and `outbound.md` updated. **(Day 3.)**
- [ ] `TODO.md` Phase Two queue replaced with a pointer to this file. **(Day 3.)**
- [x] Backup taken; commit hash recorded. Snapshot: `C:/dev/backups/skill-connections/2026-05-10T02-54-39`. Pre-day-1 commit: `7444f25`. Post-day-1 commit: `b8c7127`.

## Day 2 work plan (for the next session)

Spec section 11 day 2 lists steps 13 through 20. Below is the file-path map with the discoveries this session made (the spec's assumed paths are approximations; actual paths differ).

| Spec step | Spec file path | Actual file path | Notes |
|---|---|---|---|
| 13 (BF-1 source-classed retrieval reweight) | `07-daemon/src/lex/recall.ts` | `07-daemon/src/curation/curator.ts` (curator at UserPromptSubmit) and `07-daemon/src/dashboard/search-all.ts` (dashboard search) and `07-daemon/src/lex/system-prompt.ts` (Lex prompt context) | Three call sites; touch all three with the new source-class weights table from spec section 4.2. Hybrid scorer (OP-6) lands here too. |
| 14 (BF-2 decay scope tighten) | `07-daemon/src/reinforcement/decay.ts` | `07-daemon/src/reinforcement/index.ts` (`decayInactivePages` at line 593) | Add `if (parsed.frontmatter.frozen === true) continue;` skip. The `no_decay = 0` filter is moot here because decay never traverses `brainstorm_chunks`. **Cascading change required:** add `frozen?: boolean` plus `last_verified?: string \| null` plus `source_brainstorms`, `source_meetings`, `derived_from_brainstorm`, `derived_from_meeting` to `PageFrontmatter` in `07-daemon/src/wiki/schema.ts`. Update both `normalizeFrontmatter` (line 308) and `renderFrontmatter` (line 334). Otherwise saves strip the new fields. |
| 15 (PB-2, BF-4 outbound rule + log) | `07-daemon/src/ingest/pass2.ts` and `07-daemon/src/ingest/cross-project.ts` | `07-daemon/src/wiki/ingest.ts` (Pass 2 lives here) and **need to find** the cross-project call site (likely also in `wiki/ingest.ts` or `wiki/candidates.ts`) | Wrap every off-host call: insert `outbound_log` row with `payload_class` and `contains_voice_session_source`. Refuse before network if either is voice-derived (per spec section 3.5). Honor `DEVNEURAL_OUTBOUND_DAILY_CAP_*`. |
| 16 (CP-1 cross-project N>=3 + domain-distance) | `07-daemon/src/ingest/cross-project.ts` | same as 15 | Per Q-4 verification: project metadata has no tags. Fall back to "different project_slug = different domain" until tags are added in a follow-up. Document in a new `docs/spec/RETRIEVAL.md` (file does not exist; create it). |
| 17 (Karpathy steal 1: schema-as-living-config) | "Pass 2 prompt loader" | Find prompt builder for Pass 2 in `07-daemon/src/wiki/ingest.ts` or under `07-daemon/src/llm/` | Inject `docs/spec/DEVNEURAL.md` (or its runtime copy at `<DATA_ROOT>/wiki/DEVNEURAL.md`) into the system prompt at every Pass 2 call. |
| 18 (WI-2 frozen flag honour) | "ingest path" | `07-daemon/src/wiki/ingest.ts` and the `decayInactivePages` from step 14 | Skip frozen pages in both the ingest write path and the decay scheduler. |
| 19 (WI-5 pause mode) | "decay scheduler" | `decayInactivePages` from step 14 | Read `DEVNEURAL_PAUSE_MODE` (auto / on / off, default auto). On `on`, return early. On `auto`, check inactivity per `DEVNEURAL_PAUSE_INACTIVITY_DAYS` (default 21). |
| 20 (BF-7 session-end pipeline auto-distillation) | `07-daemon/src/lex/session-end.ts` | `07-daemon/src/lex/session-end-pipeline.ts` (existing, line 1 of the file) | **Keystone work.** Implement the 8-step ordered flush under a session-level lock per spec section 11 day 2 step 20. Add the `wiki_drafts` write step (Pass 2 against the full transcript, compute confidence per Appendix H, write rows). Set `distilled_at`. |

### Things to set up before touching code

1. **Backfill `model_id`.** Migration 002 set every existing `raw_chunks_meta` row to the placeholder `__BACKFILL_PENDING__`. After day 2 wires the embedder model id config, run a one-shot UPDATE to the configured value. Do this BEFORE day 3 brings in the reindex job.
2. **Read existing `decayInactivePages`** (line 593 of `07-daemon/src/reinforcement/index.ts`) before editing. The function operates on disk-resident wiki pages, parses each, decays weight by `DECAY_PER_SESSION`, archives below `ARCHIVE_FLOOR`. Frozen check is a `continue` near the top of the loop.
3. **Read existing `session-end-pipeline.ts`** end-to-end before editing. It currently force-flushes wiki ingest, refreshes summary, embeds summary chunk. The 8-step ordered flush keeps that behaviour and adds the lock + the `wiki_drafts` write.
4. **Outbound cap implementation** is per-day (UTC midnight). Use a query against `outbound_log` for today's row count and bytes summed.

### Day 2 commit checkpoint (per Appendix B template)

```
feat(brainstorm,curator,privacy): wave 1 code wiring

- Source-classed retrieval reweight (BF-1) with hybrid scorer.
- Decay scope tightened to non-frozen wiki pages only (BF-2, WI-2).
- Outbound rule enforcement: brainstorm content forbidden, daily cap (BF-4, PB).
- Cross-project promotion threshold raised to N=3 + domain-distance (CP-1).
- Schema-as-living-config: DEVNEURAL.md injected into Pass 2 prompt.
- Session-end auto-distillation writes pending wiki_drafts (BF-7).
```

## Day 3 work (preview, do not start until day 2 is signed off)

Spec section 11 day 3 lists steps 21 through 30. Highlights:

- 21 Curator instrumentation: write to `curator_log` and `curator_signal` tables. Find the curator at `07-daemon/src/curation/curator.ts`; the UserPromptSubmit injection point is there.
- 22 Confidence score on injection: persist + expose in `/sessions/:id` `injected_pages` array.
- 23 Curator Health endpoint + card: `GET /stats/curator-health` + `08-dashboard/components/kpi/CuratorHealthCard.tsx`.
- 24 Brainstorm KPI endpoint + tiles.
- 25 Outbound endpoint + card.
- 26 Synthetic canary at `07-daemon/scripts/canary.ts` + scheduled.
- 27 Schema regression suite at `07-daemon/tests/schema-regression/` with 50 fixtures.
- 28 README edit (PB-5 + brainstormer-first paragraph).
- 29 `outbound.md` at repo root (template in spec section 7).
- 30 Integration test scaffolding at `07-daemon/tests/integration/`. Brainstorm + curator paths first.

## Live daemon impact

The live daemon on master is **untouched** by anything on this branch.

When the user is ready to apply Phase Two changes to the live daemon:

1. Merge `phase-two` to `master` (or rebase + fast-forward).
2. Restart the daemon. The new boot wiring will run `runMigrations()` automatically and apply 001 through 009 (plus 010 through 014 once Wave 2 / 3 add them).
3. The legacy `IndexDb.migrate()` inline DDL still runs first; the new runner only handles files in `scripts/migrations/`. They coexist by design.

If a migration fails at boot, the daemon aborts loudly (per the daemon wiring's throw). No half-migrated state.

## Things this session deliberately did NOT do

- Did not run migrations against the live daemon's DB. Wait for next-boot wiring.
- Did not edit any code outside the new `src/db/`, `scripts/migrations/`, `tests/migrations/`, plus the one daemon-boot wiring change.
- Did not start day 2. The file-path discovery alone showed enough divergence from spec assumptions to deserve a fresh context window.
- Did not adopt CODEX-REVIEW-002 C1 (rename `brainstorm_*` persistence layer) or C2 (meeting KPIs). Both deferred to a later cleanup pass per the adoption summary in `CODEX-REVIEW-002.md`.

## Quick-reference: how to validate any new migration locally

```bash
# 1. Add a new file to 07-daemon/scripts/migrations/
# 2. Run against a copy of the backup:
cp "C:/dev/backups/skill-connections/<snapshot>/sqlite/index.db" /tmp/test-mig.db
mkdir -p /tmp/test-data-root/wiki
DEVNEURAL_DATA_ROOT=/tmp/test-data-root \
  npx tsx 07-daemon/src/db/migrate.ts /tmp/test-mig.db 07-daemon/scripts/migrations
# 3. Run the runner test:
cd 07-daemon && npm test -- tests/migrations/runner.test.ts
# 4. Run the full suite:
cd 07-daemon && npm test
# 5. Typecheck:
cd 07-daemon && npm run build:check
```

## End

Day 1 closes clean. Day 2 awaits a fresh session.
