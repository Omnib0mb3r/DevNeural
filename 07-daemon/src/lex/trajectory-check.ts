/* Anticipatory supervision: trajectory check (DRIVE-QUEUE 5b, EXPLORATORY
 * first slice).
 *
 * Today supervision is reactive (watch, catch drift, inject). This makes
 * it predictive: at a commit / step boundary the investigator simulates
 * "given the plan + the worker's recent trajectory, where does this go in
 * a few steps?" and outputs a PREDICTED next obstacle ("this path hits X
 * in ~N steps").
 *
 * First slice: the check + its predicted-obstacle output. It only
 * SURFACES the prediction (return / log); it never auto-acts. Pure over
 * its inputs so it is unit-testable; the live supervision loop can call
 * it at a boundary later.
 */

export type StepKind = 'edit' | 'commit' | 'tool' | 'read';

export interface TrajectoryStep {
  kind: StepKind;
  /** File / target touched (for edit/read), or tool name. */
  target?: string;
  /** Free text (commit subject, tool args). */
  text?: string;
}

export type ObstacleKind =
  | 'stuck-loop'
  | 'schema-needs-migration'
  | 'unresolved-decision';

export interface PredictedObstacle {
  kind: ObstacleKind;
  /** One-line "this path hits X in ~N steps". */
  summary: string;
  /** Rough steps-away estimate. */
  etaSteps: number;
  /** 0-1 heuristic confidence. */
  confidence: number;
  /** Supporting trajectory/plan signals. */
  evidence: string[];
}

export interface TrajectoryCheckInput {
  /** The plan / open-items text the worker is executing against. */
  plan: string;
  /** The worker's recent steps, oldest-first. */
  recentSteps: TrajectoryStep[];
  /** Edits to the same target since the last commit before flagging a
   * stuck loop. Default 3. */
  stuckEditThreshold?: number;
}

const DB_RE = /(schema|migrat|\.sql\b|\bdb\b|database|model)/i;
const MIGRATION_RE = /migrat/i;
/* An explicit X-vs-Y pair carries the most useful tokens; a bare marker
 * (decision:/TBD/...) only signals that an unresolved decision exists. */
const VS_RE = /\b(\w[\w-]*)\s+vs\.?\s+(\w[\w-]*)\b/i;
const DECISION_MARKER_RE = /decision:|\bTBD\b|undecided|choose between/i;

function stepsSinceLastCommit(steps: TrajectoryStep[]): TrajectoryStep[] {
  let lastCommit = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]!.kind === 'commit') {
      lastCommit = i;
      break;
    }
  }
  return steps.slice(lastCommit + 1);
}

/* Predict the next obstacle(s) on the current trajectory. Returns an
 * ordered list (most imminent first); empty when nothing is foreseeable.
 * Pure; no side effects, no auto-act. */
export function predictNextObstacle(
  input: TrajectoryCheckInput,
): PredictedObstacle[] {
  const out: PredictedObstacle[] = [];
  const since = stepsSinceLastCommit(input.recentSteps);
  const stuckThreshold = Math.max(2, input.stuckEditThreshold ?? 3);

  /* 1. Stuck loop: same target edited >= threshold times with no commit. */
  const editCounts = new Map<string, number>();
  for (const s of since) {
    if (s.kind === 'edit' && s.target) {
      editCounts.set(s.target, (editCounts.get(s.target) ?? 0) + 1);
    }
  }
  for (const [target, n] of editCounts) {
    if (n >= stuckThreshold) {
      out.push({
        kind: 'stuck-loop',
        summary: `Repeated edits to ${target} with no commit; this path hits a stuck loop in ~1-2 steps. Commit or step back.`,
        etaSteps: 1,
        confidence: Math.min(0.9, 0.4 + 0.15 * (n - stuckThreshold + 1)),
        evidence: [`${n} edits to ${target} since last commit`],
      });
    }
  }

  /* 2. Schema change without a migration: a DB-shaped edit and no
   * migration step in the recent trajectory. */
  const dbEdit = since.find(
    (s) => s.kind === 'edit' && DB_RE.test(`${s.target ?? ''} ${s.text ?? ''}`),
  );
  const sawMigration = input.recentSteps.some((s) =>
    MIGRATION_RE.test(`${s.target ?? ''} ${s.text ?? ''}`),
  );
  if (dbEdit && !sawMigration) {
    out.push({
      kind: 'schema-needs-migration',
      summary: `Schema/DB edit (${dbEdit.target ?? 'db'}) with no migration in the trajectory; this path hits a "needs a migration" wall in ~2-3 steps.`,
      etaSteps: 2,
      confidence: 0.6,
      evidence: [`db edit: ${dbEdit.target ?? dbEdit.text ?? '?'}`, 'no migration step seen'],
    });
  }

  /* 3. Unresolved decision in the plan the trajectory is approaching. */
  const vsMatch = VS_RE.exec(input.plan);
  const hasMarker = DECISION_MARKER_RE.test(input.plan);
  if (vsMatch || hasMarker) {
    const phrase = (vsMatch ? vsMatch[0] : input.plan.match(DECISION_MARKER_RE)?.[0] ?? 'decision').trim();
    /* Prefer the X / Y tokens from the vs-pair; otherwise scan the whole
     * plan for content words (the marker alone has no target tokens). */
    const tokenSource = vsMatch ? `${vsMatch[1]} ${vsMatch[2]}` : input.plan;
    const tokens = tokenSource
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((t) => t.length > 2);
    const approaching = input.recentSteps.some((s) => {
      const hay = `${s.target ?? ''} ${s.text ?? ''}`.toLowerCase();
      return tokens.some((t) => hay.includes(t));
    });
    if (approaching) {
      out.push({
        kind: 'unresolved-decision',
        summary: `Trajectory is approaching the unresolved decision "${phrase}"; this path hits that choice in ~2-3 steps. Resolve it upstream before the worker picks one blind.`,
        etaSteps: 3,
        confidence: 0.55,
        evidence: [`plan decision: ${phrase}`],
      });
    }
  }

  return out.sort((a, b) => a.etaSteps - b.etaSteps);
}
