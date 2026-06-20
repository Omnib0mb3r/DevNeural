-- Lifecycle dashboard (INVESTIGATOR-PIPELINE-SPEC item 8). Nullable
-- project lifecycle stage on project_session.
--
-- NULL = unset (every existing row; no backfill, no behavior change).
-- Values when set: new_project | spec | tdd | execution | test |
-- bug_handling. The stage model + allowed transitions live in
-- 07-daemon/src/lex/project-lifecycle.ts. Additive only: nothing reads or
-- writes this column yet; the lifecycle rail + stage-aware greeting wire
-- to it in a later phase.

ALTER TABLE project_session ADD COLUMN stage TEXT;
