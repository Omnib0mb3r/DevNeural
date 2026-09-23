/**
 * AUTO-CLEAR T5 handover frame (Phase C, 2026-09-22): two visible halves,
 * round-trippable, vetted structurally, reduced to a reseed paste.
 */
import { describe, expect, it } from 'vitest';
import {
  RESEED_MAX_CHARS,
  parseHandoverFrame,
  renderHandoverFrame,
  reseedFromFrame,
  richReseedFromFrame,
  vetHandoverFrame,
  type HandoverFrame,
} from '../src/lex/handover-frame.js';

const FRAME: HandoverFrame = {
  anchorId: '6c7d6691-8e72-427a-9e95-8a70161e4d34',
  kind: 'auto-clear',
  createdAt: '2026-09-22T23:10:00.000Z',
  worker: {
    author: { role: 'worker', sessionId: 'df70f86c-5219-4713-863b-22c051d20b00', at: '2026-09-22T23:09:40.000Z' },
    verifiedState: 'HEAD a62eabb on voice-layers, tree clean, no in-flight files.',
    whatIWasDoing: 'Task 5 of the voice and clear plan: the handover frame module. End of step 3.',
    decisionsInForce: 'No Anthropic API. Scope fail-closed.',
    stoppingPoint: 'Committed at a62eabb, nothing dirty.',
  },
  lex: {
    author: { role: 'lex', sessionId: 'be0ee15d-938f-4671-b858-cabf57f4aa10', at: '2026-09-22T23:10:00.000Z' },
    corrections: ['The stopping point is after Task 4, not Task 3.', 'Tests are 58, not 57.'],
    nextSteps: 'Task 6: Phase C routes. Then Task 7.',
    planReference: 'docs/superpowers/plans/2026-09-22-voice-and-clear-complete.md, Tasks 6 and 7',
    verdict: 'revised',
  },
  unvetted: false,
};

describe('renderHandoverFrame / parseHandoverFrame', () => {
  it('round-trips a reviewed frame exactly', () => {
    const md = renderHandoverFrame(FRAME);
    expect(parseHandoverFrame(md)).toEqual(FRAME);
  });
  it('a lex-self-clear frame is labelled Lex draft / Judge review and round-trips', () => {
    const f: HandoverFrame = {
      ...FRAME,
      kind: 'lex-self-clear',
      worker: { ...FRAME.worker, author: { role: 'lex', sessionId: 'cc-lex', at: FRAME.createdAt } },
      lex: { ...FRAME.lex!, author: { role: 'judge', sessionId: null, at: FRAME.createdAt }, corrections: ['judge: OK'], verdict: 'approved' },
    };
    const md = renderHandoverFrame(f);
    expect(md).toMatch(/^## Lex draft \(lex session cc-lex, /m);
    expect(md).toMatch(/^## Judge review \(approved, session none, /m);
    expect(md).not.toMatch(/Worker draft|Lex review/);
    expect(parseHandoverFrame(md)).toEqual(f);
    const rich = richReseedFromFrame(f);
    expect(rich).toMatch(/^Resume from your lex-self-clear handover of .* \(judge: approved\)\./);
    expect(rich).toContain('Judge notes:\n- judge: OK');
    expect(rich).toContain('Next steps: Task 6: Phase C routes. Then Task 7.');
    expect(rich).toContain('Plan: docs/superpowers/plans/2026-09-22-voice-and-clear-complete.md');
  });
  it('labels both halves with author and time, corrections one per line', () => {
    const md = renderHandoverFrame(FRAME);
    expect(md).toMatch(
      /^## Worker draft \(worker session df70f86c-5219-4713-863b-22c051d20b00, 2026-09-22T23:09:40\.000Z\)$/m,
    );
    expect(md).toMatch(
      /^## Lex review \(revised, session be0ee15d-938f-4671-b858-cabf57f4aa10, 2026-09-22T23:10:00\.000Z\)$/m,
    );
    expect(md).toMatch(/^### Corrections$/m);
    expect(md).toMatch(/^- The stopping point is after Task 4, not Task 3\.$/m);
    expect(md).toMatch(/^### Next steps$/m);
    expect(md.indexOf('## Worker draft')).toBeLessThan(md.indexOf('## Lex review'));
  });
  it('an unvetted crash frame carries the banner and no Lex half', () => {
    const f: HandoverFrame = {
      ...FRAME,
      kind: 'crash-recovery',
      lex: null,
      unvetted: true,
      worker: { ...FRAME.worker, author: { role: 'daemon-trail', sessionId: null, at: FRAME.createdAt } },
    };
    const md = renderHandoverFrame(f);
    expect(md).toMatch(/^> Recovered from the jsonl trail after a crash\. Unvetted\.$/m);
    expect(md).toMatch(/^## Worker draft \(daemon-trail session none,/m);
    expect(md).not.toMatch(/## Lex review/);
    expect(parseHandoverFrame(md)).toEqual(f);
  });
  it('returns null for something that is not a frame', () => {
    expect(parseHandoverFrame('# Brainstorm handover abc\n\nGenerated: x')).toBeNull();
  });
});

describe('vetHandoverFrame', () => {
  it('passes the reviewed frame', () => {
    expect(vetHandoverFrame(FRAME)).toEqual({ ok: true, issues: [] });
  });
  it('rejects empty slots, a transcript dump, a rejected review, and missing next steps', () => {
    const empty = vetHandoverFrame({
      ...FRAME,
      worker: { ...FRAME.worker, verifiedState: '', stoppingPoint: '  ' },
    });
    expect(empty.ok).toBe(false);
    expect(empty.issues).toContain('verified state is empty');
    expect(empty.issues).toContain('stopping point is empty');
    const dump = vetHandoverFrame({
      ...FRAME,
      worker: {
        ...FRAME.worker,
        whatIWasDoing: ['user: hi', 'assistant: hello', 'user: fix it', 'assistant: done', 'user: thanks', 'assistant: sure'].join('\n'),
      },
    });
    expect(dump.issues).toContain('reads like a transcript dump');
    const rejected = vetHandoverFrame({ ...FRAME, lex: { ...FRAME.lex!, verdict: 'rejected', nextSteps: '' } });
    expect(rejected.issues).toContain('rejected by Lex');
    expect(rejected.issues).toContain('Lex review has no next steps');
  });
});

describe('reseedFromFrame', () => {
  it('is plain prose under the cap with every slot and the next steps', () => {
    const r = reseedFromFrame(FRAME);
    expect(r.length).toBeLessThanOrEqual(RESEED_MAX_CHARS);
    expect(r).not.toMatch(/^#/m);
    expect(r).toMatch(/^Resume from the auto-clear handover of 2026-09-22T23:10:00\.000Z \(reviewed by Lex, revised\)\./m);
    expect(r).toMatch(/^Verified state: HEAD a62eabb/m);
    expect(r).toMatch(/^Next steps: Task 6/m);
    expect(r).toMatch(/^Corrections from Lex: The stopping point/m);
  });
  it('stays under the cap with a bloated worker half', () => {
    const r = reseedFromFrame({
      ...FRAME,
      worker: { ...FRAME.worker, whatIWasDoing: 'x '.repeat(5_000), verifiedState: 'y '.repeat(5_000) },
    });
    expect(r.length).toBeLessThanOrEqual(RESEED_MAX_CHARS);
    expect(r).toMatch(/Stopping point: Committed/);
  });
});
