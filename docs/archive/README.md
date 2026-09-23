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
  postmortems, plan docs, dated session-handover snapshots, the 2026-05
  voice design review, the HANDOVER cursors 2026-07 to 2026-09 and the
  smoke batches 2026-05 to 2026-07 trimmed out of the live files on
  2026-09-23).
- `spec/` - superseded spec files (early architecture drafts, wave
  plans, phase plans, way-forward documents, the codex reviews, the
  specs whose subject shipped: coalesce queue, event-driven
  supervision, panic button, the lex-autonomy payload and standalone
  supervision specs, the 2026-07 voice top-layer design and mic tuning,
  the 2026-07-18 bell and voice-binding fix specs, the investigator
  pipeline, whose pillars 1 to 3 were built and stay dormant behind
  flags; see `SMOKE-TEST-2026-05-to-07.md` for what is real and what
  was dropped).
- `plans/` - executed implementation plans (organic edges 2026-04, the
  voice layers 2026-09-21, the fix wave 2026-09-22, the voice v3 +
  Phase C wave 2026-09-22). Their checkboxes were never ticked; the
  commits in FIXES.md are the completion record. The 2026-09-22 fix
  wave's word gate was later withdrawn by LAYER-1-CONTROL v3.
- `bugs/` - per-bug investigation write-ups for bugs that reached
  RESOLVED (2026-05 to 2026-07). BUGS.md and FIXES.md carry the
  resolution; these hold the long-form reasoning.

Archived 2026-09-23 in the overnight reconciliation after the voice v3
+ Phase C wave. The brainstorm-folder design docs that fed those waves
(barge classifier, top-layer smarts, the resume seeds) were moved to
`<DATA_ROOT>/brainstorm/archive/` the same night.
