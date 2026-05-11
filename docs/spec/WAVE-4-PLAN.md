# Wave 4 Plan (2026-05-11 brainstorm output)

> **Origin:** Brainstorm session "Dev brainstorm season" on 2026-05-10/11, after Wave 3 execution completed and merged. Decisions captured here flow from the verification gap, Wave 3 deferrals, and Wave 2/3 formal punts.
>
> **Precondition:** Wave 3 verification pass must complete with all acceptance items PASS or formally DEFERRED before Wave 4 execution begins. Do not start Wave 4 if any Wave 3 acceptance item is still FAIL.

---

## Headline goals

Two anchors for Wave 4:

1. **Lock down Wave 3 with test coverage and finish the deferrals.** The 22 commits that shipped Wave 3 have zero new tests. Lane A also deferred orb search and keyboard navigation. Close both gaps so Wave 3 is truly done.
2. **Hardening pass on Lex memory and permissions.** Wave 3 shipped the substrate (janitor, retrieval, permission tiers). Wave 4 adds the safety rails: memory budget cap, demote-to-retrieval policy, batched approval refinement, filesystem-level permission enforcement audit.

---

## Scope

### Test coverage for Wave 3 (priority 1)

Every Wave 3 acceptance criterion needs vitest coverage. Target: bring test count from 146 to ~170+ depending on how many unit-testable seams the new code exposes.

Per feature:
- **Orb data layer:** unit tests for the unified node + edge query (brainstorms + wiki + projects + meetings into one graph)
- **Orb double-click panel:** integration test for the side panel data fetch
- **Filter chips:** state machine test for the 4-type toggle
- **Thread doc handoff:** test the end-of-brainstorm doc-writer (input chunks → expected doc) and the spawn-time injector (system prompt contains the latest thread doc)
- **Bounded retrieval:** test that a brainstorm reference triggers retrieval and pulls bounded chunk count
- **Janitor llama job:** test that duplicate memories trigger merge proposals and contradictions trigger flags, written as audit findings
- **Permission tiers:** test the filesystem enforcement layer (attempt write to read-only file should fail with expected error)
- **Internal-first retrieval tool gate:** test that WebSearch is blocked when input contains a known-internal vocab term, and unblocked when it does not
- **Cross-session injection:** test the RemoteTrigger extension auth, allowlist, and audit log writes
- **Curator events in live_state:** test that audit-finding inserts surface in the live_state output

### Lane A deferred items (priority 2)

- **Orb search.** Text input that filters and highlights matching nodes in the graph
- **Orb keyboard navigation.** Arrow keys to move between connected nodes, enter to open side panel, escape to close

### Formally punted from Wave 3

- **Crossproject_fallback UI panel.** Surface the low-band retrieval rejections from the table the backfill job already writes to. Read-only audit view at `/admin/crossproject-fallback` or similar.
- **raw_chunks_archived restore endpoint.** A POST endpoint that restores a row from `raw_chunks_archived` back into `raw_chunks_meta` by id. Soft restore semantics: re-insert without disturbing other archived rows.

### Memory and permission hardening

- **Memory budget runaway mitigation.** Cap the system prompt size at a configured budget (default ~30k tokens). When budget exceeded, demote oldest memories to "retrieval-only" status (still searchable, not always-loaded). New `memory_status` column on memory rows: always-load / retrieval-only / archived.
- **Permission tier filesystem-level enforcement audit.** Verify Wave 3 actually enforced read-only at the filesystem layer, not just via prompt instructions. If it's prompt-only, harden to chmod or separate process boundary.
- **Approval fatigue refinement.** Batched approval UI on `/system` curator panel: show grouped proposals (e.g., "5 duplicate-merge candidates"), let user approve in bulk or click-through individual items. Add a "trust delegation" toggle for low-risk merge types (pure duplicate consolidation) so they auto-apply without per-item click.

### Cross-host data root sync (lower priority, may punt to Wave 5)

- **Spec only in Wave 4, no implementation.** Document the sync strategy: which tables sync, which stay per-host, conflict resolution policy. Implementation defers to Wave 5 unless a real second host appears.

### Carry-overs from Wave 3 (none expected)

If the Wave 3 verification pass surfaces fails that weren't fixed in-place, they roll into Wave 4 as fixup items. Confirm at Wave 4 kickoff after verification report comes back.

---

## Out of scope

- Speaker diarization (Phase 7, bundled with Phase 7 Lex upgrades per memory)
- Local fine-tune harness (rejected in Wave 3 brainstorm, not coming back)
- Lex model swap (rejected, Opus 4.7 forever)
- New orb node types beyond the 4 (brainstorm, wiki, project, meeting). Resist scope creep.

---

## Lane split

This wave is less parallelizable than Wave 3 because test coverage spans both lanes. Recommend single-agent execution OR three-lane split:

### Single-agent option (recommended for safety)

One agent runs the whole scope sequentially. Atomic commits per feature. Lower coordination cost.

### Three-lane option (if user wants speed)

- **Lane A (orb finish):** orb tests + search + keyboard nav. Pure `08-dashboard` work.
- **Lane B (Lex hardening):** memory budget + permission audit + approval batching + cross-host spec. Pure `07-daemon` plus `08-dashboard/src/system/**`.
- **Lane C (carry-overs + tests):** crossproject_fallback UI + raw_chunks_archived restore + remaining test coverage gaps.

Conflict surface is small (Lane A: `08-dashboard/src/orb/**`, Lane B: `07-daemon/src/lex/**`, Lane C: spans both but in non-overlapping files). Step numbering continues from Wave 3 (last step 45 per the renumbering done in verification pass).

---

## Execution rules

- **Atomic commits per item.** No bundle commits.
- **Tests green per commit.** vitest + tsc clean across daemon and dashboard at every commit. Test count must INCREASE per item that adds a feature.
- **Stop and report when scope complete.** Do NOT proceed past lane scope.
- **Conflict avoidance:** same lane ownership rules as Wave 3.

---

## Acceptance criteria

- **All Wave 3 acceptance items have at least one vitest test.** Coverage exists for every behavior the WAVE-3-PLAN doc claimed.
- **Orb search and keyboard nav functional.** User can search for "DevNeural", graph highlights matching nodes. Arrow keys move focus between connected nodes.
- **Crossproject_fallback panel renders the table** with sortable columns and a row count.
- **raw_chunks_archived restore endpoint** accepts a row id and restores. Test confirms round-trip.
- **Memory budget enforced.** Forcing the prompt over budget triggers demote-to-retrieval. Test confirms demoted memories still surface via retrieval but not always-load.
- **Permission tier audit complete.** Doc in `docs/spec/PERMISSION-AUDIT.md` reports whether enforcement is filesystem-level or prompt-level, with remediation if prompt-only.
- **Approval batching live.** Curator panel shows grouped proposals. Trust delegation toggle works.
- **Cross-host sync spec exists** at `docs/spec/CROSS-HOST-SYNC.md`. Implementation NOT required, spec only.
- **Test count baseline.** Wave 4 entry: 146 (post Wave 3 verification). Wave 4 exit target: 170+.

---

## Invocation

User invocation phrase, to a worker session in `C:\dev\Projects\DevNeural` on `master`, after Wave 3 verification is clean:

> Read docs/spec/WAVE-4-PLAN.md and execute. Single agent, atomic commits, stop when scope is complete.

If the three-lane parallel route is preferred at execution time, swap to:

> Read docs/spec/WAVE-4-PLAN.md and execute Lanes A, B, and C as three parallel agents.

---

## Next after Wave 4

**Phase 7** is the next major arc per existing memory:
- Speaker diarization (pyannote-based, distinguish primary vs third-party speech)
- Bundled with Phase 7 Lex upgrades

That's a separate planning conversation. Wave 4 leaves a clean Wave 3 foundation for Phase 7 to build on.
