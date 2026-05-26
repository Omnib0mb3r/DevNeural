# LEX-AUTONOMY codex item 12 (FINAL): project_scope_id + kill label-only preload

**Reported:** 2026-05-26 07:08 EDT
**Status:** investigation (no code; ship spec follows)
**Related:** spec line 297; closes codex 1-12 sequence. Builds on Fix 44 (adaptive walk-back) + Fix 45 (source-graph payload).

## Q1: current label-match call sites

| Site | File:line | Purpose |
|---|---|---|
| `preloadSiblingDistillations` filter | `07-daemon/src/lex/sibling-distillation-preload.ts:82` `normLabel(r.user_label) === target` | force-distill top-N siblings by label |
| `buildSiblingIndex` label-match fallback | `07-daemon/src/lex/sibling-index.ts:331` same predicate | render block when no anchor-refs |
| Display label fallback | `07-daemon/src/lex/sibling-index.ts:302` `row.user_label?.trim() ?? derived_label` | UI label only (not scope) |
| `normLabel` helper | both files line 58 / 72 | trim + lowercase |

Label set sites (label gets STAMPED on row):
- `BrainstormSessionRow.user_label` set by `insertBrainstorm` + `updateBrainstorm` (e.g. `brainstorm-store.ts createStandaloneBrainstorm`)
- `derived_label` auto-derived from first user turn elsewhere in the corpus

No central setter. Label is set wherever a brainstorm row is created or renamed; no validation that two rows mean the same project.

## Q2: project_scope_id schema

Migration 044:

```sql
ALTER TABLE brainstorm_sessions ADD COLUMN project_scope_id TEXT;

CREATE INDEX IF NOT EXISTS ix_brainstorm_project_scope
  ON brainstorm_sessions(project_scope_id) WHERE project_scope_id IS NOT NULL;
```

Nullable. NULL = "ungrouped" (legacy + new rows that haven't been scoped). Non-null = stable opaque token shared by all brainstorms in the same project scope. Format proposal: project_scope ids are TEXT so callers can use UUID OR human-readable slug (`devneural-payload-spec`, `voice-pipeline`) at operator choice. No CHECK constraint.

Default on new inserts: NULL. Codex 11 dashboard (codex 11 deferred surface) can offer a "promote to project_scope_id" affordance per anchor.

## Q3: backfill strategy

```sql
-- Anchors with explicit supervisor binding inherit the supervisor as scope.
UPDATE brainstorm_sessions
   SET project_scope_id = supervises_project_anchor_id
 WHERE supervises_project_anchor_id IS NOT NULL
   AND project_scope_id IS NULL;
```

That backfill captures every brainstorm that has been bound via the supervises_project_anchor_id field (codex 11 grooming would have surfaced these already). Rows without a supervisor binding stay NULL; the preload sees them and falls back to label-match.

No second-pass heuristic in the migration. Label-clustering analysis (e.g. "two distinct rows with user_label='voice' should be the same scope") is operator-driven via the new PATCH endpoint (Q5), NOT migration-driven. Migration stays trivially reversible.

## Q4: sibling preload swap

### Anchor-refs primary path

Unchanged. The anchor-refs path operates on `lex_transcript_ref` rows under the active anchor; refs are anchor-scoped, not label/project-scoped.

### Label-match fallback swap

`07-daemon/src/lex/sibling-distillation-preload.ts:82`:

```typescript
const matches = rows.filter((r) => {
  if (exclude && r.id === exclude) return false;
  // codex 12: prefer project_scope_id; fall back to user_label.
  if (opts.projectScopeId && r.project_scope_id) {
    return r.project_scope_id === opts.projectScopeId;
  }
  return normLabel(r.user_label) === target;
});
```

`opts.projectScopeId` is the active anchor's project_scope_id, passed by `lex-cold-start-preamble.ts summarizeFromAnchor` after reading the anchor row.

Same swap at `sibling-index.ts:331`. Both consumers fall back to label when EITHER side is null.

After a 30-day window (or operator-driven cutoff), a follow-up commit drops the label-match branch entirely. Codex 12 ships the additive swap; the kill-switch lands in codex follow-up.

### Edge cases

- Two brainstorms share project_scope_id but have different labels → grouped correctly.
- Two brainstorms share label but have different project_scope_id → SPLIT correctly (today they're falsely grouped; codex 12 fixes this).
- Old row with NULL project_scope_id + matching label to a backfilled row → label fallback still groups them; operator can promote via PATCH.

## Q5: PATCH endpoint

```
PATCH /brainstorms/:id/project-scope
body: { project_scope_id: string | null }
response: { ok: true, brainstorm_id, project_scope_id }

Audit row:
  cross_session_injection_log
  caller_label='set-project-scope'
  text_preview=`scope=${value ?? 'null'}`
  decision='accepted'
```

Validates `project_scope_id` is either null or a non-empty trimmed string. No length cap beyond reasonable (256 chars).

## Q6: test outline

`07-daemon/tests/project-scope-id.test.ts`:

- Migration 044 backfill: rows with supervisor inherit; rows without stay NULL.
- `insertBrainstorm` accepts project_scope_id field (additive optional).
- `updateBrainstorm` allows setting + clearing project_scope_id.
- `preloadSiblingDistillations`: scope-match takes precedence; falls back to label when current anchor has no scope.
- `buildSiblingIndex` label-match branch: same swap pinned.
- PATCH endpoint: 200 + audit row on valid scope; 400 on garbage; 404 on missing anchor; null clears.
- Edge: two rows same label different scopes → not grouped together.
- Edge: two rows same scope different labels → grouped together.

## Proposed ship-spec deliverables

1. Migration 044: `ALTER TABLE brainstorm_sessions ADD COLUMN project_scope_id TEXT` + index + backfill UPDATE.
2. `BrainstormSessionRow.project_scope_id?: string | null` on the TypeScript shape.
3. `insertBrainstorm` + `updateBrainstorm` accept the new field.
4. `preloadSiblingDistillations` + `buildSiblingIndex` filter swap (scope wins, label falls back).
5. `summarizeFromAnchor` reads anchor's project_scope_id and threads via `opts.projectScopeId`.
6. PATCH route + audit.
7. Tests per Q6.
8. Fix 49 FIXES row.

### Defaults

```
PROJECT_SCOPE_ID_MAX_CHARS = 256
```

No constants; the column is operator-driven free-form.

## Out of scope (defer)

- Killing label-match branch entirely (follow-up after 30-day backfill window).
- Dashboard UI for setting project_scope_id (codex follow-up).
- Auto-clustering by label similarity (heuristic; never reliable).
- Multi-scope brainstorm rows (a single row in two project scopes) — not supported by the design; one scope per brainstorm.

## Cross-references

- Migration 025 `supervises_project_anchor_id` (backfill source).
- `07-daemon/src/lex/sibling-distillation-preload.ts:60` `preloadSiblingDistillations`.
- `07-daemon/src/lex/sibling-index.ts:319` `buildLabelMatchBlock`.
- `07-daemon/src/lex/lex-cold-start-preamble.ts:summarizeFromAnchor` (Fix 45) - opts thread point.
- Codex 11 grooming `runGroomingTick` (Fix 48) - future surface where scope grouping can drive cross-anchor escalation rollups.
