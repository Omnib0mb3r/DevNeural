/**
 * The Lex context pack: rich by design, scoped to one worker, capped only
 * by a runaway guard.
 */
import { describe, expect, it } from 'vitest';
import {
  buildLexContextPack,
  extractTurnSummaries,
  openBugRows,
  planTaskState,
  resolvePlanRef,
} from '../src/lex/lex-context-pack.js';
import { renderHandoverFrame, type HandoverFrame } from '../src/lex/handover-frame.js';

const WORKER_FRAME: HandoverFrame = {
  anchorId: 'bs-1',
  kind: 'auto-clear',
  createdAt: '2026-09-22T22:00:00.000Z',
  worker: {
    author: { role: 'worker', sessionId: 'cc-w', at: '2026-09-22T21:59:00.000Z' },
    verifiedState: 'HEAD abc1234 on voice-layers, tree clean.',
    whatIWasDoing: 'Task 8, end of step 2.',
    decisionsInForce: 'No Anthropic API.',
    stoppingPoint: 'Committed.',
  },
  lex: {
    author: { role: 'lex', sessionId: 'cc-lex', at: '2026-09-22T22:00:00.000Z' },
    corrections: ['Step 2 is the router, not the detector.'],
    nextSteps: 'Task 9.',
    planReference: 'docs/plan.md, Task 9',
    verdict: 'revised',
  },
  unvetted: false,
};

const LEX_FRAME: HandoverFrame = {
  ...WORKER_FRAME,
  kind: 'lex-self-clear',
  createdAt: '2026-09-22T23:00:00.000Z',
  worker: { ...WORKER_FRAME.worker, author: { role: 'lex', sessionId: 'cc-lex', at: '2026-09-22T23:00:00.000Z' } },
  lex: { ...WORKER_FRAME.lex!, author: { role: 'judge', sessionId: null, at: '2026-09-22T23:00:00.000Z' }, verdict: 'approved' },
};

const PLAN = [
  '# The plan',
  '',
  '### Task 8: things',
  '- [x] Tests',
  '- [x] Implement',
  '### Task 9: more things',
  '- [ ] Tests',
  '- [ ] Implement',
  'some prose that is not a task line',
].join('\n');

const BUGS = [
  '<!-- INDEX START -->',
  '| BUG-031 | RESOLVED | L1 died at boot |',
  '| BUG-032 | SMOKE-TESTING | per-sentence WAV blobs |',
  '| BUG-034 | OPEN | supervisor re-fires test_failure off a stale tail |',
  '<!-- INDEX END -->',
  '<!-- DETAILS START -->',
  '| BUG-099 | OPEN | this row is in the details, not the index |',
].join('\n');

function jsonl(text: string, stop = 'end_turn'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-22T22:00:00.000Z',
    message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
  });
}

const LONG = 'Task 8 is done: handover approval by voice is wired and the tests are green across the board.';

function fakeFs() {
  const files = new Map<string, string>();
  const root = 'C:/fake/brainstorms';
  files.set(`${root}/bs-1/HANDOVER-2026-09-22T22-00-00-000Z.md`, renderHandoverFrame(WORKER_FRAME));
  files.set(`${root}/bs-1/HANDOVER-2026-09-22T23-00-00-000Z.md`, renderHandoverFrame(LEX_FRAME));
  files.set('C:/p/worker/docs/plan.md', PLAN);
  files.set('C:/p/worker/BUGS.md', BUGS);
  const handoverFs = {
    rootDir: root,
    readdir: (dir: string) =>
      [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    readFile: (p: string) => {
      const v = files.get(p.replace(/\\/g, '/'));
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    exists: (p: string) => files.has(p.replace(/\\/g, '/')) || p.replace(/\\/g, '/') === `${root}/bs-1`,
    writeFile: () => undefined,
    rename: () => undefined,
    mkdir: () => undefined,
  };
  return { files, handoverFs, readFile: (p: string) => files.get(p.replace(/\\/g, '/')) ?? null };
}

describe('lex context pack', () => {
  it('assembles worker, handovers in full, plan task state, summaries, bugs and the digest', () => {
    const { handoverFs, readFile } = fakeFs();
    const pack = buildLexContextPack({
      brainstormId: 'bs-1',
      worker: { anchorId: 'proj-w', slug: 'worker-proj', cwd: 'C:/p/worker', sessionId: 'cc-w' },
      probe: () => ({ headSha: 'abc1234', branch: 'voice-layers', dirty: false, lastCommitSubject: 'feat: x' }),
      recentCommits: () => ['abc1234 feat: x', '9999999 fix: y'],
      handoverFs,
      readFile,
      readTail: () => [jsonl(LONG), jsonl('On it.'), jsonl(LONG + ' Also lint.', 'tool_use')].join('\n'),
      transcriptPath: () => 'C:/fake/worker.jsonl',
      digest: { currentTask: 'Task 9', lastDecision: 'rich pack', openQuestion: 'none', workerStatus: 'busy', nextSteps: 'T12' },
    });
    expect(pack.sections).toEqual(['worker', 'worker-handovers', 'lex-handover', 'plan', 'summaries', 'bugs', 'digest']);
    expect(pack.truncated).toBe(false);
    expect(pack.text).toContain('## Your worker: worker-proj');
    expect(pack.text).toContain('- git: branch voice-layers HEAD abc1234, tree clean');
    expect(pack.text).toContain('  - 9999999 fix: y');
    /* Both halves of the worker handover, in full. */
    expect(pack.text).toContain('## Worker draft (worker session cc-w');
    expect(pack.text).toContain('- Step 2 is the router, not the detector.');
    expect(pack.text).toContain('## Your own last handover');
    expect(pack.text).toContain('## Judge review (approved');
    expect(pack.text).toContain('## Plan task state (C:/p/worker/docs/plan.md)');
    expect(pack.text).toContain('- [ ] Implement');
    expect(pack.text).not.toContain('some prose');
    expect(pack.text).toContain('## What the worker reported lately');
    expect(pack.text).toContain(`- ${LONG}`);
    expect(pack.text).not.toContain('Also lint');
    expect(pack.text).toContain('| BUG-034 | OPEN |');
    expect(pack.text).toContain('| BUG-032 | SMOKE-TESTING |');
    expect(pack.text).not.toContain('BUG-031');
    expect(pack.text).not.toContain('BUG-099');
    expect(pack.text).toContain('- next steps: T12');
  });

  it('with no worker bound it says so and reads nothing from any project', () => {
    const { handoverFs, readFile } = fakeFs();
    const pack = buildLexContextPack({ brainstormId: 'bs-9', worker: null, handoverFs, readFile });
    expect(pack.sections).toEqual(['worker']);
    expect(pack.text).toBe('## Your worker\nNo worker is bound to this brainstorm.');
  });

  it('drops the lowest-priority sections first at the cap and says so', () => {
    const { handoverFs, readFile } = fakeFs();
    const pack = buildLexContextPack({
      brainstormId: 'bs-1',
      worker: { anchorId: 'proj-w', slug: 'worker-proj', cwd: 'C:/p/worker', sessionId: null },
      probe: () => ({ headSha: null, branch: null, dirty: false, lastCommitSubject: null }),
      recentCommits: () => [],
      handoverFs,
      readFile,
      maxChars: 300,
    });
    expect(pack.sections).toEqual(['worker']);
    expect(pack.truncated).toBe(true);
    expect(pack.text).toMatch(/\(context pack truncated at the size cap\)$/);
  });
});

describe('helpers', () => {
  it('extractTurnSummaries keeps end-turn texts of 80+ chars, newest last, capped', () => {
    const tail = [jsonl('short'), jsonl(LONG + ' 1'), jsonl(LONG + ' 2', 'tool_use'), 'not json', jsonl(LONG + ' 3')].join('\n');
    expect(extractTurnSummaries(tail, 1)).toEqual([LONG + ' 3']);
    expect(extractTurnSummaries(tail)).toEqual([LONG + ' 1', LONG + ' 3']);
  });
  it('openBugRows reads only the index block, only live statuses', () => {
    expect(openBugRows(BUGS)).toEqual([
      '| BUG-032 | SMOKE-TESTING | per-sentence WAV blobs |',
      '| BUG-034 | OPEN | supervisor re-fires test_failure off a stale tail |',
    ]);
  });
  it('planTaskState keeps headings and checkbox lines only', () => {
    expect(planTaskState(PLAN)).toEqual([
      '# The plan',
      '### Task 8: things',
      '- [x] Tests',
      '- [x] Implement',
      '### Task 9: more things',
      '- [ ] Tests',
      '- [ ] Implement',
    ]);
  });
  it('resolvePlanRef tries the roots in order and strips a trailing task note', () => {
    const exists = (p: string) => p === 'C:/two/docs/plan.md';
    expect(resolvePlanRef('docs/plan.md, Task 9', ['C:/one', 'C:/two'], exists)).toBe('C:/two/docs/plan.md');
    expect(resolvePlanRef('docs/plan.md', ['C:/one'], exists)).toBeNull();
    expect(resolvePlanRef('C:/two/docs/plan.md', [], exists)).toBe('C:/two/docs/plan.md');
  });
});
