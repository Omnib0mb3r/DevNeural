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
  extractWorkerActivity,
  buildWorkerActivityBlock,
  assembleSmartClearReport,
  vetReseed,
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

/* ── worker-anchored activity (2026-07-16 live failure) ─────────────────
 *
 * POST /lex/smart-clear/plan targets a WORKER anchor (a project_session
 * id). Those anchors have NO brainstorm row, so the brainstorm-anchored
 * investigator fails closed and the whole sweep came back empty: the
 * 05:11:01Z draft carried only git signals (HEAD sha, dirty flag), no
 * active work, and vetReseed rightly rejected it for "no next step".
 * The worker's live jsonl tail is the active-work source: the latest
 * substantial user directive carries the current task, the queued next
 * items, and the standing constraints verbatim. These tests pin that
 * extraction and that the resulting draft passes the (unchanged) vet
 * gate on its own. */

const DIRECTIVE = [
  'Resume: DevNeural worker. Verified state noted.',
  'NEXT TASK, start immediately: voice status pill alignment in VoiceClient.tsx - consolidate the label maps.',
  'QUEUE after that: smart-clear draft fix, then smart-compact session-ready wait widening.',
  'CONSTRAINTS: additive only; tests green before and after; NEVER restart the daemon yourself.',
].join('\n');

function jsonlLine(rec: unknown): string {
  return JSON.stringify(rec);
}

const WORKER_JSONL = [
  jsonlLine({
    type: 'user',
    message: { role: 'user', content: 'an older short user turn that is long enough to be substantial but stale' },
  }),
  jsonlLine({
    type: 'user',
    message: {
      role: 'user',
      content: `<system-reminder>huge harness noise that must not become the directive</system-reminder>${DIRECTIVE}`,
    },
  }),
  jsonlLine({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Pill task start. Reading VoiceClient status maps now.' }],
    },
  }),
  jsonlLine({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x', content: 'file body '.repeat(40) }],
    },
  }),
  jsonlLine({ type: 'user', message: { role: 'user', content: 'short steer' } }),
].join('\n');

describe('extractWorkerActivity', () => {
  it('picks the LATEST substantial user directive, reminder-stripped, and the last worker reply', () => {
    const a = extractWorkerActivity(WORKER_JSONL);
    expect(a.directive).toBeTruthy();
    expect(a.directive).toContain('voice status pill alignment');
    expect(a.directive).not.toContain('harness noise');
    expect(a.directive).not.toContain('older short user turn');
    expect(a.reply).toContain('Pill task start');
  });

  it('pulls queued next items and standing constraints from the directive lines', () => {
    const a = extractWorkerActivity(WORKER_JSONL);
    expect(a.nextItems.join(' ')).toContain('smart-clear draft fix');
    expect(a.constraints.join(' ').toLowerCase()).toContain('additive only');
    expect(a.constraints.join(' ')).toContain('NEVER restart the daemon');
  });

  it('ignores tool_result-only records and sub-threshold steering turns', () => {
    const a = extractWorkerActivity(WORKER_JSONL);
    expect(a.directive).not.toContain('file body');
    expect(a.directive).not.toContain('short steer');
  });

  it('returns an empty activity for an empty / unparseable tail', () => {
    const a = extractWorkerActivity('not json\n{"type":"summary"}');
    expect(a.directive).toBeNull();
    expect(a.nextItems).toEqual([]);
    expect(a.constraints).toEqual([]);
  });

  it('reads operator directives delivered as queue-operation records (live 2026-07-16 shape)', () => {
    /* Mid-turn operator messages do NOT land as type:"user" records -
     * they are stored as {type:"queue-operation", operation:"enqueue",
     * content:"<full text>"}. Verified against the live session jsonl:
     * every QUEUE ADDITION tonight is one of these; the user-record
     * scan alone misses all of them. */
    const tail = [
      jsonlLine({
        type: 'user',
        message: { role: 'user', content: 'an early ordinary user turn long enough to clear the substantial floor' },
      }),
      jsonlLine({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          'QUEUE ADDITION (operator-approved): fix the replay-on-switch gate next; CONSTRAINTS: additive only, NEVER restart the daemon.',
      }),
      jsonlLine({ type: 'queue-operation', operation: 'dequeue' }),
    ].join('\n');
    const a = extractWorkerActivity(tail);
    expect(a.directive).toContain('replay-on-switch gate');
    expect(a.nextItems.join(' ')).toContain('replay-on-switch');
    expect(a.constraints.join(' ')).toContain('NEVER restart the daemon');
  });
});

describe('buildWorkerActivityBlock', () => {
  it('renders task / next / constraints / reply and stays bounded', () => {
    const big = extractWorkerActivity(WORKER_JSONL);
    const block = buildWorkerActivityBlock(big);
    expect(block).toContain('voice status pill alignment');
    expect(block).toContain('smart-clear draft fix');
    expect(block.toLowerCase()).toContain('additive only');
    expect(block).toContain('Pill task start');
  });

  it('returns empty for empty activity (fail-closed, no fabricated content)', () => {
    const block = buildWorkerActivityBlock(extractWorkerActivity(''));
    expect(block).toBe('');
  });
});

describe('assembleSmartClearReport on a WORKER anchor (no brainstorm row)', () => {
  const workerDb = {
    getBrainstorm: () => null,
  } as unknown as IndexDb;

  it('regression pin: without a worker jsonl the sweep is empty and vet rejects (the 05:11Z failure)', () => {
    const out = assembleSmartClearReport({
      db: workerDb,
      anchorId: 'worker-anchor',
      cwd: '/proj',
      label: 'DevNeural-433a2f',
      repoProbe: () => DIRTY,
      listDir: () => [],
      readFile: () => null,
    });
    expect(out.hasContent).toBe(false);
    const vet = vetReseed(out.reseed);
    expect(vet.ok).toBe(false);
    expect(vet.issues.join(' ')).toContain('no next step');
  });

  it('worker jsonl tail fills the draft: current task + next queue + constraints, and it passes the unchanged vet gate', () => {
    const out = assembleSmartClearReport({
      db: workerDb,
      anchorId: 'worker-anchor',
      cwd: '/proj',
      label: 'DevNeural-433a2f',
      repoProbe: () => CLEAN,
      listDir: () => [],
      readFile: (p) => (p === '/tail/worker.jsonl' ? WORKER_JSONL : null),
      workerJsonlPath: '/tail/worker.jsonl',
    });
    expect(out.hasContent).toBe(true);
    expect(out.report).toContain('voice status pill alignment');
    expect(out.reseed).toContain('HEAD abc1234');
    expect(out.reseed.toLowerCase()).toContain('next:');
    expect(out.reseed).toContain('smart-clear draft fix');
    const vet = vetReseed(out.reseed);
    expect(vet.ok).toBe(true);
    expect(vet.issues).toEqual([]);
  });

  it('stays within the vet gate bounds even when the directive is huge', () => {
    const hugeDirective = `NEXT TASK: the real work item. ${'padding sentence with detail. '.repeat(400)}`;
    const hugeJsonl = jsonlLine({
      type: 'user',
      message: { role: 'user', content: hugeDirective },
    });
    const out = assembleSmartClearReport({
      db: workerDb,
      anchorId: 'worker-anchor',
      cwd: '/proj',
      label: 'DevNeural-433a2f',
      repoProbe: () => CLEAN,
      listDir: () => [],
      readFile: () => hugeJsonl,
      workerJsonlPath: '/tail/worker.jsonl',
    });
    const vet = vetReseed(out.reseed);
    expect(vet.ok).toBe(true);
  });

  it('a reply-only tail (no directive) never leaks the block header into the reseed hints', () => {
    /* Live 2026-07-16 probe defect: with a tail that yielded only an
     * assistant reply, the report-wide heuristic fallback grabbed the
     * worker block HEADER as "Were doing: Worker active context (live
     * session tail)". Hints must come from structured extraction (or
     * the investigator block), never from the worker block's own
     * scaffolding. */
    const replyOnly = jsonlLine({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Committed the pill fix, suite green.' }],
      },
    });
    const out = assembleSmartClearReport({
      db: workerDb,
      anchorId: 'worker-anchor',
      cwd: '/proj',
      label: 'DevNeural-433a2f',
      repoProbe: () => CLEAN,
      listDir: () => [],
      readFile: () => replyOnly,
      workerJsonlPath: '/tail/worker.jsonl',
    });
    expect(out.reseed).not.toContain('Worker active context');
    expect(out.report).toContain('Committed the pill fix');
  });

  it('brainstorm-anchored assembly still wins the hint merge when both sources exist', () => {
    const bothDb = {
      getBrainstorm: () => ({ id: 'anchor1', user_label: 'DevNeural' }),
    } as unknown as IndexDb;
    const out = assembleSmartClearReport({
      db: bothDb,
      anchorId: 'anchor1',
      cwd: '/proj',
      label: 'DevNeural',
      repoProbe: () => CLEAN,
      listDir: (p) => (p === '/proj' ? ['PROJECT.md'] : []),
      readFile: (p) =>
        p === '/proj/PROJECT.md'
          ? '# PROJECT\nproject doc body for the report.'
          : p === '/tail/worker.jsonl'
            ? WORKER_JSONL
            : null,
      workerJsonlPath: '/tail/worker.jsonl',
    });
    /* Both blocks land in the report; the worker tail leads because the
     * live directive is the freshest signal of what to resume on. */
    expect(out.report).toContain('voice status pill alignment');
    expect(out.report).toContain('project doc body');
    expect(out.hasContent).toBe(true);
    expect(vetReseed(out.reseed).ok).toBe(true);
  });
});
