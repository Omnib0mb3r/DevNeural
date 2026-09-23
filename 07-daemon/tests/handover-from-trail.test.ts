/**
 * Session-end and crash handovers from the trail (Phase C, 2026-09-22):
 * the worker's own last words and the repo probe fill the frame, marked
 * unvetted, authored by the daemon reading the tail.
 */
import { describe, expect, it } from 'vitest';
import { buildTrailHandover, writeTrailHandover } from '../src/lex/handover-from-trail.js';

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

const DIRECTIVE = 'Implement Task 7: write a handover at every session end and after a crash, from the jsonl trail, marked unvetted, with tests. Commit when green.';
const TAIL = jsonl([
  { type: 'user', message: { role: 'user', content: DIRECTIVE } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Task 7 written, tests green, committed as 1234abc.' }] } },
]);

const deps = {
  worker: { role: 'worker' as const, sessionId: 'cc-w', cwd: 'C:/p/proj' },
  lex: { role: 'lex' as const, sessionId: 'cc-l', cwd: 'C:/data/brainstorm' },
  readTail: () => TAIL,
  probe: () => ({ headSha: '1234abc', branch: 'voice-layers', dirty: false, lastCommitSubject: 'feat: task 7' }),
  transcriptPath: (cwd: string, sid: string) => `${cwd}/${sid}.jsonl`,
  now: () => Date.parse('2026-09-22T23:30:00.000Z'),
};

describe('buildTrailHandover', () => {
  it('fills the worker half from the tail and the repo, unvetted, authored by the daemon', () => {
    const f = buildTrailHandover('bs-1', 'session-end', deps);
    expect(f).not.toBeNull();
    expect(f!.kind).toBe('session-end');
    expect(f!.unvetted).toBe(true);
    expect(f!.lex).toBeNull();
    expect(f!.worker.author).toEqual({ role: 'daemon-trail', sessionId: 'cc-w', at: '2026-09-22T23:30:00.000Z' });
    expect(f!.worker.verifiedState).toBe('branch voice-layers, HEAD 1234abc, working tree clean, last commit "feat: task 7"');
    expect(f!.worker.whatIWasDoing).toMatch(/^The worker: Latest directive: Implement Task 7/);
    expect(f!.worker.whatIWasDoing).toMatch(/Latest reply: Task 7 written/);
    expect(f!.worker.stoppingPoint).toMatch(/^The session ended\. Safe to stop now/);
  });
  it('a crash says so and a dirty tree becomes commit-first', () => {
    const f = buildTrailHandover('bs-1', 'crash-recovery', {
      ...deps,
      probe: () => ({ headSha: 'abc', branch: 'b', dirty: true, lastCommitSubject: null }),
    });
    expect(f!.worker.stoppingPoint).toMatch(/^The session died without a clean end\. Commit the current work first/);
    expect(f!.worker.verifiedState).toMatch(/DIRTY/);
  });
  it('falls back to the brainstorm session when no worker is bound, and to null with none', () => {
    const f = buildTrailHandover('bs-1', 'session-end', { ...deps, worker: null });
    expect(f!.worker.author.sessionId).toBe('cc-l');
    expect(f!.worker.whatIWasDoing).toMatch(/^Lex: /);
    expect(buildTrailHandover('bs-1', 'session-end', { ...deps, worker: null, lex: null })).toBeNull();
  });
});

describe('writeTrailHandover', () => {
  it('persists through the injected fs and never throws', () => {
    const files = new Map<string, string>();
    const logs: string[] = [];
    const file = writeTrailHandover(
      'bs-1',
      'crash-recovery',
      deps,
      { rootDir: 'C:/mem', writeFile: (p, c) => void files.set(p, c), mkdir: () => undefined },
      (m) => logs.push(m),
    );
    expect(file).toMatch(/^HANDOVER-2026-09-22_23-30-00-000Z\.md$/);
    const [content] = [...files.values()];
    expect(content).toMatch(/^> Recovered from the jsonl trail after a crash\. Unvetted\.$/m);
    expect(logs.join('\n')).toMatch(/crash-recovery: wrote HANDOVER-/);
    const none = writeTrailHandover(
      'bs-1',
      'session-end',
      { ...deps, worker: null, lex: null },
      { rootDir: 'C:/mem', writeFile: () => { throw new Error('no'); }, mkdir: () => undefined },
      (m) => logs.push(m),
    );
    expect(none).toBeNull();
  });
});
