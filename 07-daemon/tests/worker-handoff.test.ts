/* Worker-side context handoff doc.
 *
 * Pins the regression that drove the build: the prior session's
 * stop_hook_summary one-liner did not carry enough context across
 * /clear or fresh-session boundaries. buildWorkerHandoff must emit
 * a structured block covering ALL FOUR sections (Where you left off,
 * Active task, Next up, Open blockers) on every successful render,
 * including the empty-state legs (clean tree, empty queue, no
 * blockers) so the worker can resume without surprises.
 */
import { describe, expect, it } from 'vitest';
import type { IndexDb, ProjectSessionRow, AuditFindingRow } from '../src/store/index-db.js';
import { buildWorkerHandoff } from '../src/lex/worker-handoff.js';

function makeAnchor(cwd: string): ProjectSessionRow {
  return {
    id: 'p-anchor',
    project_slug: 'demo',
    cwd,
    current_session_id: null,
    current_pty_id: null,
    title: null,
    status: 'live',
    created_ms: 1,
    last_seen_ms: 2,
  } as unknown as ProjectSessionRow;
}

function makeFinding(id: string, finding: string): AuditFindingRow {
  return {
    id,
    source: 'lint',
    severity: 'high',
    page_slug: null,
    brainstorm_id: null,
    finding,
    detail: null,
    status: 'open',
    created_at: '2026-05-15T00:00:00Z',
    resolved_at: null,
  } as unknown as AuditFindingRow;
}

function makeDbStub(opts: {
  anchorCwd?: string | null;
  findings?: AuditFindingRow[];
}): IndexDb {
  return {
    getProjectSessionByCwd: (cwd: string) =>
      opts.anchorCwd === cwd ? makeAnchor(cwd) : null,
    listAuditFindings: () => opts.findings ?? [],
  } as unknown as IndexDb;
}

function fakeGit(): (args: string[], cwd: string) => string | null {
  const responses: Record<string, string> = {
    'rev-parse --abbrev-ref HEAD': 'master',
    'log -1 --pretty=%s': 'fix(lex): restore cold-start preload density',
    'log -1 --pretty=%h': 'c9e3c49',
    'status --short':
      ' M 07-daemon/src/lex/worker-handoff.ts\n?? docs/scratch.md\n',
  };
  return (args: string[]) => responses[args.join(' ')] ?? null;
}

const FAKE_BACKLOG = JSON.stringify([
  { id: 'past-1', status: 'done', title: 'old work' },
  {
    id: 'worker-clear-handoff',
    status: 'in-flight',
    title: 'Build a worker handoff doc covering git state, active task, next 2-3 queued, and open blockers.',
  },
  { id: 'next-a', status: 'queued', title: 'Wire mobile cache-busting' },
  { id: 'next-b', status: 'queued', title: 'Audit findings UI sort' },
  { id: 'next-c', title: 'Stream Deck refresh cadence' }, // no status -> treated as not-done
  { id: 'next-d', status: 'queued', title: 'Should not appear' },
]);

describe('buildWorkerHandoff', () => {
  it('emits all four section headings with structured content', () => {
    const cwd = '/repo/demo';
    const db = makeDbStub({
      anchorCwd: cwd,
      findings: [
        makeFinding('finding-1', 'wiki page X drifted from canonical'),
      ],
    });
    const result = buildWorkerHandoff({
      cwd,
      db,
      backlogPath: '/tmp/fake.json',
      readBacklog: () => FAKE_BACKLOG,
      runGit: fakeGit(),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('rendered');

    const block = result.block;
    /* All four section headings must always be present so the worker
     * sees a consistent shape even when a section is empty. */
    expect(block).toMatch(/## Where you left off/);
    expect(block).toMatch(/## Active task/);
    expect(block).toMatch(/## Next up/);
    expect(block).toMatch(/## Open blockers/);

    /* Where-you-left-off content. */
    expect(block).toMatch(/Branch: master/);
    expect(block).toMatch(/c9e3c49 fix\(lex\)/);
    expect(block).toMatch(/worker-handoff\.ts/);

    /* Active task content. */
    expect(block).toMatch(/worker-clear-handoff/);
    expect(block).toMatch(/git state, active task/);

    /* Next-up content: top 3 queued, in the seeded order. */
    expect(block).toMatch(/next-a/);
    expect(block).toMatch(/next-b/);
    expect(block).toMatch(/next-c/);
    expect(block).not.toMatch(/next-d/);
    /* Done entries must not surface as next-up. */
    expect(block).not.toMatch(/past-1/);

    /* Blocker content. */
    expect(block).toMatch(/finding-1/);
    expect(block).toMatch(/canonical/);

    /* Sections object mirrors the rendered block. */
    expect(result.sections.where_left_off.branch).toBe('master');
    expect(result.sections.active_task?.id).toBe('worker-clear-handoff');
    expect(result.sections.next_up.map((e) => e.id)).toEqual([
      'next-a',
      'next-b',
      'next-c',
    ]);
    expect(result.sections.open_blockers).toHaveLength(1);
  });

  it('keeps all four headings in the empty-state legs', () => {
    const cwd = '/repo/empty';
    const result = buildWorkerHandoff({
      cwd,
      db: makeDbStub({ anchorCwd: cwd, findings: [] }),
      backlogPath: '/tmp/empty.json',
      readBacklog: () => '[]',
      runGit: (args) =>
        args[0] === 'status' ? '' : args.join(' ') === 'rev-parse --abbrev-ref HEAD' ? 'main' : null,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('rendered');
    expect(result.block).toMatch(/## Where you left off/);
    expect(result.block).toMatch(/## Active task/);
    expect(result.block).toMatch(/## Next up/);
    expect(result.block).toMatch(/## Open blockers/);
    expect(result.block).toMatch(/no in-flight task/);
    expect(result.block).toMatch(/queue empty/);
    expect(result.block).toMatch(/working tree clean/);
  });

  it('returns empty block for cwds outside a project anchor', () => {
    const cwd = '/repo/not-a-project';
    const result = buildWorkerHandoff({
      cwd,
      db: makeDbStub({ anchorCwd: '/repo/different' }),
      backlogPath: '/tmp/nope.json',
      readBacklog: () => FAKE_BACKLOG,
      runGit: fakeGit(),
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('not-a-project-anchor');
    expect(result.block).toBe('');
  });

  it('returns empty block when cwd is missing', () => {
    const result = buildWorkerHandoff({
      cwd: '',
      db: null,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('no-cwd');
    expect(result.block).toBe('');
  });

  it('caps next-up at the configured limit', () => {
    const cwd = '/repo/cap';
    const result = buildWorkerHandoff({
      cwd,
      db: makeDbStub({ anchorCwd: cwd, findings: [] }),
      backlogPath: '/tmp/cap.json',
      readBacklog: () => FAKE_BACKLOG,
      runGit: fakeGit(),
      nextUpLimit: 2,
    });
    expect(result.sections.next_up.map((e) => e.id)).toEqual([
      'next-a',
      'next-b',
    ]);
  });

  it('survives unreadable backlog + null git output without throwing', () => {
    const cwd = '/repo/broken';
    const result = buildWorkerHandoff({
      cwd,
      db: makeDbStub({ anchorCwd: cwd, findings: [] }),
      backlogPath: '/tmp/broken.json',
      readBacklog: () => null,
      runGit: () => null,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('rendered');
    expect(result.block).toMatch(/## Where you left off/);
    expect(result.sections.where_left_off.branch).toBeNull();
    expect(result.sections.active_task).toBeNull();
    expect(result.sections.next_up).toHaveLength(0);
  });
});
