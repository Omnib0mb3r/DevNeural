/**
 * Project lifecycle stage model (spec item 8 scaffold). Pure module;
 * pins the stage order, allowed transitions, and the stubbed exit
 * criteria (every gate returns satisfied=false / TODO for now).
 */
import { describe, expect, it } from 'vitest';
import {
  PROJECT_STAGES,
  STAGE_TRANSITIONS,
  canTransition,
  nextStage,
  isProjectStage,
  stageExitSatisfied,
} from '../src/lex/project-lifecycle.js';

describe('project lifecycle stages', () => {
  it('has the six gates in order', () => {
    expect(PROJECT_STAGES).toEqual([
      'new_project',
      'spec',
      'tdd',
      'execution',
      'test',
      'bug_handling',
    ]);
  });

  it('isProjectStage guards', () => {
    expect(isProjectStage('spec')).toBe(true);
    expect(isProjectStage('nope')).toBe(false);
    expect(isProjectStage(null)).toBe(false);
  });

  it('allows linear forward transitions only', () => {
    expect(canTransition('new_project', 'spec')).toBe(true);
    expect(canTransition('spec', 'tdd')).toBe(true);
    expect(canTransition('execution', 'test')).toBe(true);
    /* no skipping forward */
    expect(canTransition('spec', 'execution')).toBe(false);
    expect(canTransition('new_project', 'tdd')).toBe(false);
  });

  it('lets bug_handling loop back for rework', () => {
    expect(STAGE_TRANSITIONS.bug_handling).toEqual(['spec', 'tdd', 'execution']);
    expect(canTransition('bug_handling', 'spec')).toBe(true);
    expect(canTransition('bug_handling', 'new_project')).toBe(false);
  });

  it('nextStage walks the linear path then stops', () => {
    expect(nextStage('new_project')).toBe('spec');
    expect(nextStage('test')).toBe('bug_handling');
    expect(nextStage('bug_handling')).toBeNull();
  });

  it('every gate exit criterion is stubbed (satisfied=false, TODO)', () => {
    for (const stage of PROJECT_STAGES) {
      const r = stageExitSatisfied(stage);
      expect(r.satisfied).toBe(false);
      expect(r.reason).toMatch(/TODO/);
    }
  });
});
