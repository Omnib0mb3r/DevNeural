/* Project lifecycle stage model (spec item 8 scaffold, 2026-06-20).
 *
 * The lifecycle dashboard treats a project as a gated state machine:
 * New Project -> Spec -> TDD -> Execution -> Test -> Bug handling. Each
 * gate has an objective exit criterion; you cannot advance until the
 * current gate is satisfied.
 *
 * This module is PURE + ADDITIVE: it defines the stages, the allowed
 * transitions, and an exit-criterion STUB per gate. Nothing calls it yet
 * - the dashboard rail and the stage-aware greeting wire to it in a later
 * phase. The exit-criterion functions deliberately return false (a gate
 * is never auto-satisfied) until the real probes land.
 */

export type ProjectStage =
  | 'new_project'
  | 'spec'
  | 'tdd'
  | 'execution'
  | 'test'
  | 'bug_handling';

/* Forward order of the lifecycle. NULL stage (unset, the migration
 * default) is "before new_project" - not in this list. */
export const PROJECT_STAGES: ProjectStage[] = [
  'new_project',
  'spec',
  'tdd',
  'execution',
  'test',
  'bug_handling',
];

export function isProjectStage(v: unknown): v is ProjectStage {
  return typeof v === 'string' && (PROJECT_STAGES as string[]).includes(v);
}

/* Allowed transitions. Linear forward by default; bug_handling can loop
 * back to spec/tdd/execution for rework (a wrong test upgrades the spec;
 * a fix re-enters execution). A gate never skips forward. */
export const STAGE_TRANSITIONS: Record<ProjectStage, ProjectStage[]> = {
  new_project: ['spec'],
  spec: ['tdd'],
  tdd: ['execution'],
  execution: ['test'],
  test: ['bug_handling'],
  bug_handling: ['spec', 'tdd', 'execution'],
};

export function canTransition(from: ProjectStage, to: ProjectStage): boolean {
  return STAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

/* The next forward stage, or null at the end of the linear path
 * (bug_handling has no single forward step - it loops by rework). */
export function nextStage(stage: ProjectStage): ProjectStage | null {
  const i = PROJECT_STAGES.indexOf(stage);
  if (i < 0 || i >= PROJECT_STAGES.length - 1) return null;
  return PROJECT_STAGES[i + 1]!;
}

/* Context an exit-criterion probe will eventually need (anchor id, db
 * handle, test results). Kept minimal + optional while stubbed. */
export interface StageExitContext {
  anchorId?: string;
}

export interface StageExitResult {
  satisfied: boolean;
  /* Human-readable reason; "TODO" while the real probe is unimplemented. */
  reason: string;
}

/* Objective exit criterion per gate. STUB: returns satisfied=false with a
 * TODO reason for every stage. The real probes (intake filled, plan
 * frozen to tests, tests green + metric moved, triage clear) land in a
 * later phase; until then a gate is never auto-advanced. */
export function stageExitSatisfied(
  stage: ProjectStage,
  _ctx?: StageExitContext,
): StageExitResult {
  switch (stage) {
    case 'new_project':
      return { satisfied: false, reason: 'TODO: intake fields filled' };
    case 'spec':
      return { satisfied: false, reason: 'TODO: brainstorm plan dialed in' };
    case 'tdd':
      return {
        satisfied: false,
        reason: 'TODO: every check has a runnable probe',
      };
    case 'execution':
      return { satisfied: false, reason: 'TODO: worker drove plan to done' };
    case 'test':
      return {
        satisfied: false,
        reason: 'TODO: all tests green + real metric moved',
      };
    case 'bug_handling':
      return { satisfied: false, reason: 'TODO: triage clear / project done' };
    default:
      return { satisfied: false, reason: 'TODO: unknown stage' };
  }
}
