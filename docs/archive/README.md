# docs/archive

Historical material that the codebase no longer relies on but which is
preserved for provenance: superseded handovers, postmortems, completed
wave plans, the pre-FUNCTIONAL-SPEC architecture drafts. Read these
only when you need to know how something used to work or why a past
decision was made.

The active doc surface lives one level up under `docs/`. The rolling
resume pointer is `docs/HANDOVER.md`. The active smoke gate is
`docs/SMOKE-TEST.md`. The active spec set is `docs/spec/`.

Do NOT add new files here directly. Files arrive in this folder only
when an active doc has been superseded and a `git mv` lands it here
in the same commit that updates `docs/INDEX.md` to drop the entry.

## Layout

- `*.md` at the root - superseded top-level docs (HANDOVERs,
  postmortems, plan docs, dated session-handover snapshots).
- `spec/` - superseded spec files (early architecture drafts, wave
  plans, phase plans, way-forward documents).
