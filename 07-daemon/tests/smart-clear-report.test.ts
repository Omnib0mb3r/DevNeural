/**
 * Smart-clear investigator report + two artifacts (DRIVE-QUEUE 4B). Pins
 * the safe stopping point (commit-first when dirty, after-commit when
 * clean, never mid-edit), the adaptive-sufficiency reseed draft (verified
 * HEAD + next, not a transcript), and the broad-sweep assembly.
 */
import { describe, expect, it } from 'vitest';
import type { IndexDb } from '../src/store/index-db.js';
import {
  draftStoppingPoint,
  draftReseed,
  extractThreadHints,
  assembleSmartClearReport,
  type RepoSignals,
} from '../src/lex/smart-clear.js';

const CLEAN: RepoSignals = {
  headSha: 'abc1234',
  branch: 'master',
  dirty: false,
  lastCommitSubject: 'feat: prior step',
};
const DIRTY: RepoSignals = { ...CLEAN, dirty: true };

describe('draftStoppingPoint', () => {
  it('commit-first when the tree is dirty (never eat WIP / mid-edit)', () => {
    const s = draftStoppingPoint(DIRTY);
    expect(s.toLowerCase()).toContain('commit');
    expect(s.toLowerCase()).toContain('first');
    expect(s.toLowerCase()).toContain('mid-edit');
  });
  it('after-the-commit boundary when clean, citing HEAD', () => {
    const s = draftStoppingPoint(CLEAN);
    expect(s.toLowerCase()).toContain('safe to stop');
    expect(s).toContain('abc1234');
    expect(s.toLowerCase()).toContain('never mid-edit');
  });
});

describe('extractThreadHints', () => {
  it('pulls doing / next / decisions from the report', () => {
    const report = [
      '# Project + specs',
      'Currently working on the smart-clear trail.',
      'Next: wire the confirm probe.',
      'Decision: Lex vets the reseed before injecting.',
    ].join('\n');
    const h = extractThreadHints(report);
    expect(h.doing).toBeTruthy();
    expect(h.next?.toLowerCase()).toContain('confirm probe');
    expect(h.decisions.join(' ').toLowerCase()).toContain('vets the reseed');
  });
});

describe('draftReseed', () => {
  it('carries verified HEAD + next; is a reseed not a transcript', () => {
    const r = draftReseed({
      label: 'DevNeural',
      signals: CLEAN,
      stoppingPoint: draftStoppingPoint(CLEAN),
      hints: { doing: 'wiring smart-clear', next: 'wire the trail', decisions: ['Lex vets'] },
    });
    expect(r).toContain('HEAD abc1234');
    expect(r).toContain('on master');
    expect(r.toLowerCase()).toContain('next: wire the trail');
    expect(r.toLowerCase()).toContain('reseed, not the transcript');
  });
  it('flags a dirty tree so the reseed never lands on uncommitted work', () => {
    const r = draftReseed({
      label: 'DevNeural',
      signals: DIRTY,
      stoppingPoint: draftStoppingPoint(DIRTY),
      hints: { doing: null, next: null, decisions: [] },
    });
    expect(r).toContain('DIRTY');
  });
});

describe('assembleSmartClearReport (broad sweep + artifacts)', () => {
  it('assembles the report from project docs and grounds the artifacts', () => {
    const fakeDb = {
      getBrainstorm: () => ({ id: 'anchor1', user_label: 'DevNeural' }),
    } as unknown as IndexDb;
    const out = assembleSmartClearReport({
      db: fakeDb,
      anchorId: 'anchor1',
      cwd: '/proj',
      label: 'DevNeural',
      repoProbe: () => CLEAN,
      listDir: (p) => (p === '/proj' ? ['PROJECT.md'] : []),
      readFile: (p) =>
        p === '/proj/PROJECT.md'
          ? '# PROJECT\nCurrently working on smart-clear.\nNext: wire the trail-confirm.\nDecision: investigator assembles, Lex fires.'
          : null,
    });
    expect(out.hasContent).toBe(true);
    expect(out.report).toContain('smart-clear');
    expect(out.stoppingPoint).toContain('abc1234');
    expect(out.reseed).toContain('HEAD abc1234');
    expect(out.reseed.toLowerCase()).toContain('next:');
    expect(out.signals.dirty).toBe(false);
  });

  it('commit-first stopping point when the probe reports dirty', () => {
    const fakeDb = {
      getBrainstorm: () => ({ id: 'anchor1', user_label: 'DevNeural' }),
    } as unknown as IndexDb;
    const out = assembleSmartClearReport({
      db: fakeDb,
      anchorId: 'anchor1',
      cwd: '/proj',
      label: 'DevNeural',
      repoProbe: () => DIRTY,
      listDir: () => ['PROJECT.md'],
      readFile: () => '# PROJECT\nwork in progress',
    });
    expect(out.stoppingPoint.toLowerCase()).toContain('commit');
    expect(out.reseed).toContain('DIRTY');
  });
});
