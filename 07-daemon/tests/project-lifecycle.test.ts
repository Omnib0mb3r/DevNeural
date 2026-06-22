/**
 * Project lifecycle stage model + runnable gates (DRIVE-QUEUE 3). Pins the
 * stage order + transitions, the effective-stage default for NULL rows,
 * the objective gate probe (signals -> satisfied verdict), the stage-aware
 * greeting line, and the signal gatherer over a working dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PROJECT_STAGES,
  STAGE_TRANSITIONS,
  canTransition,
  nextStage,
  isProjectStage,
  effectiveStage,
  gateProbe,
  gateNeeds,
  lifecycleGreetingLine,
  type GateSignals,
} from '../src/lex/project-lifecycle.js';
import { gatherGateSignals } from '../src/lex/project-lifecycle-probes.js';

const SIGNALS_NONE: GateSignals = {
  hasIntake: false,
  hasSpecDoc: false,
  hasTests: false,
  hasTestRunner: false,
  suiteGreen: null,
  openBugs: null,
};

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
    expect(canTransition('execution', 'test')).toBe(true);
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
});

describe('effectiveStage (NULL default)', () => {
  it('returns an explicit valid stage as-is', () => {
    expect(effectiveStage({ stage: 'spec' })).toBe('spec');
  });
  it('NULL stage on a live project defaults to execution', () => {
    expect(effectiveStage({ stage: null, status: 'live' })).toBe('execution');
  });
  it('NULL stage on a dormant / cold start defaults to new_project', () => {
    expect(effectiveStage({ stage: null, status: 'dormant' })).toBe('new_project');
    expect(effectiveStage({})).toBe('new_project');
  });
  it('an invalid stored stage falls back to the default', () => {
    expect(effectiveStage({ stage: 'garbage', status: 'live' })).toBe('execution');
  });
});

describe('gateProbe (runnable exit criteria)', () => {
  it('new_project advances only with intake', () => {
    expect(gateProbe('new_project', SIGNALS_NONE).satisfied).toBe(false);
    expect(gateProbe('new_project', { ...SIGNALS_NONE, hasIntake: true }).satisfied).toBe(true);
  });
  it('spec advances only with a spec doc', () => {
    expect(gateProbe('spec', SIGNALS_NONE).satisfied).toBe(false);
    expect(gateProbe('spec', { ...SIGNALS_NONE, hasSpecDoc: true }).satisfied).toBe(true);
  });
  it('tdd advances only with tests', () => {
    expect(gateProbe('tdd', { ...SIGNALS_NONE, hasTests: true }).satisfied).toBe(true);
    expect(gateProbe('tdd', SIGNALS_NONE).satisfied).toBe(false);
  });
  it('execution advances only with a test runner', () => {
    expect(gateProbe('execution', { ...SIGNALS_NONE, hasTestRunner: true }).satisfied).toBe(true);
  });
  it('test needs the suite green; not-run is not satisfied', () => {
    expect(gateProbe('test', { ...SIGNALS_NONE, suiteGreen: null }).satisfied).toBe(false);
    expect(gateProbe('test', { ...SIGNALS_NONE, suiteGreen: false }).satisfied).toBe(false);
    expect(gateProbe('test', { ...SIGNALS_NONE, suiteGreen: true }).satisfied).toBe(true);
  });
  it('bug_handling needs green + no open bugs', () => {
    expect(gateProbe('bug_handling', { ...SIGNALS_NONE, suiteGreen: true, openBugs: 0 }).satisfied).toBe(true);
    expect(gateProbe('bug_handling', { ...SIGNALS_NONE, suiteGreen: true, openBugs: 2 }).satisfied).toBe(false);
    expect(gateProbe('bug_handling', { ...SIGNALS_NONE, suiteGreen: false, openBugs: 0 }).satisfied).toBe(false);
  });
});

describe('lifecycleGreetingLine', () => {
  it('states the stage + what the gate needs next', () => {
    const line = lifecycleGreetingLine({ stage: 'execution' });
    expect(line).toContain('Execution');
    expect(line).toContain('Test');
    expect(line).toContain(gateNeeds('execution'));
  });
  it('NULL live project greets at Execution', () => {
    expect(lifecycleGreetingLine({ stage: null, status: 'live' })).toContain('Execution');
  });
  it('bug_handling notes the rework loop', () => {
    expect(lifecycleGreetingLine({ stage: 'bug_handling' })).toMatch(/loops back/i);
  });
});

describe('gatherGateSignals (probes over a working dir)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-lifecycle-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects intake, spec doc, tests, and the test runner from the fs', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    fs.mkdirSync(path.join(dir, 'docs', 'spec'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'spec', 'PLAN.md'), '# plan');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.test.ts'), 'test');
    const s = gatherGateSignals(dir);
    expect(s.hasIntake).toBe(true);
    expect(s.hasSpecDoc).toBe(true);
    expect(s.hasTests).toBe(true);
    expect(s.hasTestRunner).toBe(true);
    expect(s.suiteGreen).toBeNull(); // not run unless opted in
  });

  it('an empty cold-start dir satisfies no gate', () => {
    const s = gatherGateSignals(dir);
    expect(s.hasIntake).toBe(false);
    expect(s.hasSpecDoc).toBe(false);
    expect(s.hasTests).toBe(false);
    expect(s.hasTestRunner).toBe(false);
    expect(gateProbe('new_project', s).satisfied).toBe(false);
  });

  it('counts open bug docs and runs the suite only when opted in', () => {
    fs.mkdirSync(path.join(dir, 'docs', 'bugs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'bugs', 'open.md'), '# bug\n\n**Status:** open\n');
    fs.writeFileSync(path.join(dir, 'docs', 'bugs', 'done.md'), '# bug\n\n**Status:** fixed\n');
    const cheap = gatherGateSignals(dir);
    expect(cheap.openBugs).toBe(1);
    /* opt-in suite run via an injected fake runner. */
    const opted = gatherGateSignals(dir, {
      runTests: true,
      env: { runTests: () => ({ ok: true, ms: 5 }) },
    });
    expect(opted.suiteGreen).toBe(true);
  });
});
