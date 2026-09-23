/**
 * Lex self-clear (T4): the fact check, the judge verdict parser, the
 * stagger gate and the serve-once reseed. Pure.
 */
import { describe, expect, it } from 'vitest';
import {
  PENDING_RESEED_TTL_MS,
  SelfClearGate,
  WORKER_CLEAR_IN_FLIGHT_TTL_MS,
  buildJudgePrompt,
  factCheckSelfClear,
  parseJudgeVerdict,
  selfClearDuePrompt,
  type SelfClearFacts,
} from '../src/lex/lex-self-clear.js';
import type { HandoverFrame } from '../src/lex/handover-frame.js';

const FRAME: HandoverFrame = {
  anchorId: 'bs-1',
  kind: 'lex-self-clear',
  createdAt: '2026-09-22T23:30:00.000Z',
  worker: {
    author: { role: 'lex', sessionId: 'cc-lex', at: '2026-09-22T23:30:00.000Z' },
    verifiedState: 'The worker is at HEAD 4ea4a15 on voice-layers, tree clean.',
    whatIWasDoing: 'Supervising the worker through Task 9 of the voice and clear plan.',
    decisionsInForce: 'No Anthropic API. One wave, no phases.',
    stoppingPoint: 'The worker committed Task 8; Task 9 is being written.',
  },
  lex: {
    author: { role: 'judge', sessionId: null, at: '2026-09-22T23:30:00.000Z' },
    corrections: [],
    nextSteps: 'Watch the worker finish Task 9, then Task 12 (build, restart, verify).',
    planReference: 'docs/superpowers/plans/2026-09-22-voice-and-clear-complete.md, Task 9',
    verdict: 'approved',
  },
  unvetted: false,
};

function facts(over: Partial<SelfClearFacts> = {}): SelfClearFacts {
  return {
    workerHead: '4ea4a15c0ffee0000000000000000000000000000',
    workerBranch: 'voice-layers',
    workerSessionId: 'cc-worker',
    planExists: () => true,
    pendingHandoverId: null,
    pendingDispatch: null,
    ...over,
  };
}

describe('factCheckSelfClear', () => {
  it('passes a draft that matches the live facts', () => {
    expect(factCheckSelfClear(FRAME, facts())).toEqual({ ok: true, issues: [] });
  });

  it('flags a sha that is not the worker HEAD', () => {
    const r = factCheckSelfClear(FRAME, facts({ workerHead: 'deadbeef1234' }));
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/commit 4ea4a15 is not the worker's HEAD \(deadbeef\)/);
  });

  it('flags a plan reference that does not resolve and a missing one', () => {
    const r = factCheckSelfClear(FRAME, facts({ planExists: () => false }));
    expect(r.issues).toEqual([
      'plan reference "docs/superpowers/plans/2026-09-22-voice-and-clear-complete.md" does not resolve to a file',
    ]);
    const none = factCheckSelfClear(
      { ...FRAME, lex: { ...FRAME.lex!, planReference: '' } },
      facts(),
    );
    expect(none.issues).toEqual(['no plan reference named']);
  });

  it('flags pending items the draft does not mention, and a worker never named', () => {
    const r = factCheckSelfClear(
      FRAME,
      facts({ pendingHandoverId: 'HANDOVER-x.md', pendingDispatch: 'run the tests' }),
    );
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0]).toMatch(/handover \(HANDOVER-x\.md\) is waiting/);
    expect(r.issues[1]).toMatch(/dispatch is parked/);
    const noWorker = factCheckSelfClear(
      {
        ...FRAME,
        worker: { ...FRAME.worker, verifiedState: 'all good', whatIWasDoing: 'thinking', stoppingPoint: 'now' },
        lex: { ...FRAME.lex!, nextSteps: 'more', planReference: 'plan.md' },
      },
      facts({ workerHead: null }),
    );
    expect(noWorker.issues).toEqual(['a worker is bound and the draft never mentions the worker']);
  });
});

describe('parseJudgeVerdict', () => {
  it('reads OK, NO with a reason, and a chatty OK', () => {
    expect(parseJudgeVerdict('OK')).toEqual({ ok: true, note: '' });
    expect(parseJudgeVerdict('ok - reads fine')).toEqual({ ok: true, note: 'reads fine' });
    expect(parseJudgeVerdict('NO: the next steps do not name the plan task')).toEqual({
      ok: false,
      note: 'the next steps do not name the plan task',
    });
    expect(parseJudgeVerdict('Looks OK to me.')).toEqual({ ok: true, note: 'Looks OK to me.' });
    expect(parseJudgeVerdict(null)).toBeNull();
    expect(parseJudgeVerdict('   ')).toBeNull();
    expect(parseJudgeVerdict('I cannot tell')).toBeNull();
  });

  it('the judge prompt carries the facts, the automatic flags and every slot', () => {
    const p = buildJudgePrompt(FRAME, facts({ pendingHandoverId: 'HANDOVER-x.md' }), ['flag one']);
    expect(p).toContain('worker HEAD: 4ea4a15c0ffee0000000000000000000000000000 on voice-layers');
    expect(p).toContain('pending handover: HANDOVER-x.md');
    expect(p).toContain('  - flag one');
    expect(p).toContain('Next steps: Watch the worker finish Task 9');
    expect(selfClearDuePrompt(72.4, 70)).toMatch(/^\[self-clear-due\] Your context is at 72% \(setpoint 70%\)/);
  });
});

describe('SelfClearGate', () => {
  it('blocks while a worker clear is in flight and expires it on its own', () => {
    let now = 1_000;
    const g = new SelfClearGate(() => now);
    expect(g.workerClearInFlight('a')).toBe(false);
    g.workerClearStart('a');
    expect(g.workerClearInFlight('a')).toBe(true);
    now += WORKER_CLEAR_IN_FLIGHT_TTL_MS + 1;
    expect(g.workerClearInFlight('a')).toBe(false);
    g.workerClearStart('a');
    g.workerClearEnd('a');
    expect(g.workerClearInFlight('a')).toBe(false);
  });

  it('serves the newest pending reseed exactly once and drops a stale one', () => {
    let now = 1_000;
    const g = new SelfClearGate(() => now);
    expect(g.takePendingReseed()).toBeNull();
    g.setPendingReseed({ brainstormId: 'bs-1', handoverId: 'h1', reseed: 'one' });
    expect(g.lexClearPending('bs-1')).toBe(true);
    now += 10;
    g.setPendingReseed({ brainstormId: 'bs-2', handoverId: 'h2', reseed: 'two' });
    expect(g.takePendingReseed()?.reseed).toBe('two');
    expect(g.lexClearPending('bs-2')).toBe(false);
    expect(g.takePendingReseed()?.reseed).toBe('one');
    expect(g.takePendingReseed()).toBeNull();
    g.setPendingReseed({ brainstormId: 'bs-3', handoverId: 'h3', reseed: 'three' });
    now += PENDING_RESEED_TTL_MS + 1;
    expect(g.takePendingReseed()).toBeNull();
    expect(g.lexClearPending('bs-3')).toBe(false);
  });
});
