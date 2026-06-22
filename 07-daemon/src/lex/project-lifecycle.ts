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

/* Human labels for the rail + greeting (mirrors the dashboard rail). */
export const STAGE_LABEL: Record<ProjectStage, string> = {
  new_project: 'New Project',
  spec: 'Spec',
  tdd: 'TDD',
  execution: 'Execution',
  test: 'Test',
  bug_handling: 'Bug handling',
};

/* Resolve the effective stage for a project_session row. An explicit
 * valid stage wins. A NULL stage (the migration default on every existing
 * row) defaults sensibly: a LIVE project is mid-flight -> Execution; an
 * empty / dormant cold start -> New Project. Pure; takes only the two
 * fields it needs so it does not couple to the full row type. */
export function effectiveStage(row: {
  stage?: string | null;
  status?: string | null;
}): ProjectStage {
  if (isProjectStage(row.stage)) return row.stage;
  return row.status === 'live' ? 'execution' : 'new_project';
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

export interface StageExitResult {
  satisfied: boolean;
  /* Human-readable reason the gate is / is not satisfied. */
  reason: string;
}

/* Objective signals an exit-criterion probe reads. Gathered against the
 * project's working dir by project-lifecycle-probes.gatherGateSignals;
 * kept as plain booleans so the gate logic below stays a PURE function
 * (testable without a filesystem or a test runner). */
export interface GateSignals {
  /** Intake done: the repo is set up (README / package.json / project.json). */
  hasIntake: boolean;
  /** A spec doc exists in the repo. */
  hasSpecDoc: boolean;
  /** At least one test file exists for the work. */
  hasTests: boolean;
  /** A runnable test command is configured (package.json test script). */
  hasTestRunner: boolean;
  /** Suite ran green. null = not run (e.g. the GET did not opt in). */
  suiteGreen: boolean | null;
  /** Count of open bug docs. null = unknown / not scanned. */
  openBugs: number | null;
}

/* The RUNNABLE exit criterion per gate. Each stage maps to one objective
 * signal; the state machine may advance only when it is satisfied. This
 * replaces the old always-false stub: the gate is now decided by real
 * probes, not vibes. Pure - the side-effecting probes live in
 * project-lifecycle-probes.ts and feed in via GateSignals. */
export function gateProbe(
  stage: ProjectStage,
  s: GateSignals,
): StageExitResult {
  switch (stage) {
    case 'new_project':
      return s.hasIntake
        ? { satisfied: true, reason: 'intake present (repo set up)' }
        : { satisfied: false, reason: 'no intake: add a README / package.json' };
    case 'spec':
      return s.hasSpecDoc
        ? { satisfied: true, reason: 'spec doc found' }
        : { satisfied: false, reason: 'no spec doc in the repo' };
    case 'tdd':
      return s.hasTests
        ? { satisfied: true, reason: 'tests exist for the work' }
        : { satisfied: false, reason: 'no test files yet' };
    case 'execution':
      return s.hasTestRunner
        ? { satisfied: true, reason: 'a runnable test command is configured' }
        : { satisfied: false, reason: 'no test runner (package.json test script)' };
    case 'test':
      if (s.suiteGreen === true) {
        return { satisfied: true, reason: 'suite green' };
      }
      if (s.suiteGreen === false) {
        return { satisfied: false, reason: 'suite is red' };
      }
      return { satisfied: false, reason: 'suite not run yet (run the tests to confirm green)' };
    case 'bug_handling':
      if (s.suiteGreen === false) {
        return { satisfied: false, reason: 'suite is red' };
      }
      if (s.openBugs && s.openBugs > 0) {
        return { satisfied: false, reason: `${s.openBugs} open bug doc(s)` };
      }
      if (s.suiteGreen === null) {
        return { satisfied: false, reason: 'suite not run yet (run the tests to confirm green)' };
      }
      return { satisfied: true, reason: 'triage clear: suite green, no open bugs' };
    default:
      return { satisfied: false, reason: 'unknown stage' };
  }
}

/* One-line "what this gate needs next" for the stage-aware greeting. */
export function gateNeeds(stage: ProjectStage): string {
  switch (stage) {
    case 'new_project':
      return 'intake (a README / package.json so the repo is set up)';
    case 'spec':
      return 'a spec doc in the repo';
    case 'tdd':
      return 'tests for the work';
    case 'execution':
      return 'a runnable test command';
    case 'test':
      return 'the suite green';
    case 'bug_handling':
      return 'triage clear (suite green, no open bugs)';
    default:
      return 'an objective exit criterion';
  }
}

/* Stage-aware greeting line. States the project's current stage + what
 * the gate needs to advance. Pure (no probes run) so it is cheap to
 * append on every cold start. The cold-start route appends it ADDITIVELY
 * to the existing preamble. */
export function lifecycleGreetingLine(row: {
  stage?: string | null;
  status?: string | null;
}): string {
  const stage = effectiveStage(row);
  const next = nextStage(stage);
  const head = `Lifecycle stage: ${STAGE_LABEL[stage]}`;
  if (!next) {
    return `${head}. Bug handling loops back to spec / tdd / execution on rework.`;
  }
  return `${head}. Next gate -> ${STAGE_LABEL[next]}: needs ${gateNeeds(stage)}.`;
}
