/**
 * Project lifecycle stages for the rail (DRIVE-QUEUE 3). Mirrors the
 * daemon's ProjectStage model (07-daemon/src/lex/project-lifecycle.ts).
 * Pure + shared so the order + lookup are unit-testable without rendering.
 */
export interface LifecycleStage {
  key: string;
  label: string;
  blurb: string;
}

export const LIFECYCLE_STAGES: LifecycleStage[] = [
  {
    key: "new_project",
    label: "New Project",
    blurb: "Intake: name, topology, technology, target outcome, scope.",
  },
  {
    key: "spec",
    label: "Spec",
    blurb: "Brainstorm until the plan is dialed in (framework + decisions).",
  },
  {
    key: "tdd",
    label: "TDD",
    blurb: "Plan becomes tests + a definition of passing, result-level.",
  },
  {
    key: "execution",
    label: "Execution",
    blurb: "Lex drives the worker through the plan.",
  },
  {
    key: "test",
    label: "Test",
    blurb: "Drive to green: all tests pass and the real metric moves.",
  },
  {
    key: "bug_handling",
    label: "Bug handling",
    blurb: "Triage + close; meta-loop on wrong tests; done when clean.",
  },
];

/** Index of a stage key in the forward order, or -1 if unknown. */
export function stageIndex(key: string | null | undefined): number {
  if (!key) return -1;
  return LIFECYCLE_STAGES.findIndex((s) => s.key === key);
}
