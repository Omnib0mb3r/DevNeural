/**
 * Anticipatory supervision trajectory check (DRIVE-QUEUE 5b). Pins the
 * predicted-obstacle output: stuck loop, schema-needs-migration, and an
 * approaching unresolved decision. Output is surfaced only (no auto-act).
 */
import { describe, expect, it } from 'vitest';
import {
  predictNextObstacle,
  type TrajectoryStep,
} from '../src/lex/trajectory-check.js';

describe('predictNextObstacle', () => {
  it('predicts a stuck loop on repeated edits with no commit', () => {
    const steps: TrajectoryStep[] = [
      { kind: 'commit', text: 'feat: x' },
      { kind: 'edit', target: 'a.ts' },
      { kind: 'edit', target: 'a.ts' },
      { kind: 'edit', target: 'a.ts' },
    ];
    const obs = predictNextObstacle({ plan: '', recentSteps: steps });
    const stuck = obs.find((o) => o.kind === 'stuck-loop')!;
    expect(stuck).toBeTruthy();
    expect(stuck.etaSteps).toBe(1);
    expect(stuck.confidence).toBeGreaterThan(0.3);
  });

  it('does not flag a stuck loop after a commit resets the window', () => {
    const steps: TrajectoryStep[] = [
      { kind: 'edit', target: 'a.ts' },
      { kind: 'edit', target: 'a.ts' },
      { kind: 'commit', text: 'feat: landed' },
      { kind: 'edit', target: 'a.ts' },
    ];
    expect(
      predictNextObstacle({ plan: '', recentSteps: steps }).some(
        (o) => o.kind === 'stuck-loop',
      ),
    ).toBe(false);
  });

  it('predicts schema-needs-migration on a DB edit with no migration step', () => {
    const steps: TrajectoryStep[] = [
      { kind: 'edit', target: 'src/store/index-db.ts', text: 'add column' },
    ];
    const obs = predictNextObstacle({ plan: '', recentSteps: steps });
    expect(obs.some((o) => o.kind === 'schema-needs-migration')).toBe(true);
  });

  it('does NOT flag schema when a migration step is present', () => {
    const steps: TrajectoryStep[] = [
      { kind: 'edit', target: 'src/store/index-db.ts' },
      { kind: 'edit', target: 'scripts/migrations/046-add-col.sql' },
    ];
    expect(
      predictNextObstacle({ plan: '', recentSteps: steps }).some(
        (o) => o.kind === 'schema-needs-migration',
      ),
    ).toBe(false);
  });

  it('predicts an approaching unresolved decision from the plan', () => {
    const obs = predictNextObstacle({
      plan: 'Step 4: pick the store. Decision: sqlite vs postgres still TBD.',
      recentSteps: [{ kind: 'edit', target: 'src/db/sqlite-adapter.ts' }],
    });
    expect(obs.some((o) => o.kind === 'unresolved-decision')).toBe(true);
  });

  it('returns nothing on a clean trajectory', () => {
    expect(
      predictNextObstacle({
        plan: 'do the thing',
        recentSteps: [{ kind: 'commit', text: 'done' }],
      }),
    ).toEqual([]);
  });
});
