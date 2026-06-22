/**
 * Memory-that-compounds: standards proposer (DRIVE-QUEUE 5a). Pins the
 * pattern detection (repeated trade-off -> meta-rule; contradiction
 * flagged) and that proposals are candidates only (never auto-applied).
 */
import { describe, expect, it } from 'vitest';
import {
  proposeStandards,
  confirmStandard,
  StandardsStore,
  type MemoryRecord,
} from '../src/lex/standards-store.js';

const now = () => 1_000;

describe('proposeStandards', () => {
  it('proposes a meta-rule when the same choice repeats >= threshold', () => {
    const recs: MemoryRecord[] = [
      { id: 'a', topic: 'db', choice: 'sqlite', ts: 1 },
      { id: 'b', topic: 'db', choice: 'sqlite', ts: 2 },
      { id: 'c', topic: 'db', choice: 'sqlite', ts: 3 },
    ];
    const out = proposeStandards(recs, { now });
    const rule = out.find((c) => c.kind === 'meta-rule')!;
    expect(rule).toBeTruthy();
    expect(rule.choice).toBe('sqlite');
    expect(rule.evidenceIds).toEqual(['a', 'b', 'c']);
    expect(rule.status).toBe('candidate'); // never auto-applied
  });

  it('does not propose a meta-rule below the threshold', () => {
    const recs: MemoryRecord[] = [
      { id: 'a', topic: 'db', choice: 'sqlite', ts: 1 },
      { id: 'b', topic: 'db', choice: 'sqlite', ts: 2 },
    ];
    expect(proposeStandards(recs, { now }).some((c) => c.kind === 'meta-rule')).toBe(false);
  });

  it('flags a contradiction when a newer choice differs on the same topic', () => {
    const recs: MemoryRecord[] = [
      { id: 'a', topic: 'db', choice: 'sqlite', ts: 1 },
      { id: 'b', topic: 'db', choice: 'postgres', ts: 5 },
    ];
    const contra = proposeStandards(recs, { now }).find((c) => c.kind === 'contradiction')!;
    expect(contra).toBeTruthy();
    expect(contra.choice).toBe('postgres');
    expect(contra.priorChoice).toBe('sqlite');
    expect(contra.status).toBe('candidate');
  });

  it('confirmStandard flips status without applying a live rule', () => {
    const [c] = proposeStandards(
      [
        { id: 'a', topic: 'db', choice: 'sqlite', ts: 1 },
        { id: 'b', topic: 'db', choice: 'sqlite', ts: 2 },
        { id: 'c', topic: 'db', choice: 'sqlite', ts: 3 },
      ],
      { now },
    );
    expect(confirmStandard(c!).status).toBe('confirmed');
    expect(c!.status).toBe('candidate'); // original untouched (no auto-apply)
  });
});

describe('StandardsStore', () => {
  it('dedupes candidates across repeated proposer runs', () => {
    const store = new StandardsStore();
    const recs: MemoryRecord[] = [
      { id: 'a', topic: 'db', choice: 'sqlite', ts: 1 },
      { id: 'b', topic: 'db', choice: 'sqlite', ts: 2 },
      { id: 'c', topic: 'db', choice: 'sqlite', ts: 3 },
    ];
    const first = store.propose(recs, { now });
    expect(first.length).toBeGreaterThan(0);
    const second = store.propose(recs, { now });
    expect(second).toEqual([]); // no duplicates piled up
    expect(store.list('meta-rule').length).toBe(1);
  });
});
