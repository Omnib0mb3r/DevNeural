import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE_CLASS_WEIGHTS,
  type SourceClass,
} from '../src/dashboard/search-all.js';

describe('DEFAULT_SOURCE_CLASS_WEIGHTS (BF-1, BF-16)', () => {
  it('matches PHASE-TWO-IMPLEMENTATION.md section 4.2 spec defaults', () => {
    expect(DEFAULT_SOURCE_CLASS_WEIGHTS.brainstorm).toBe(1.2);
    expect(DEFAULT_SOURCE_CLASS_WEIGHTS.wiki).toBe(1.0);
    expect(DEFAULT_SOURCE_CLASS_WEIGHTS.meeting).toBe(0.9);
    expect(DEFAULT_SOURCE_CLASS_WEIGHTS.draft).toBe(0.85);
    expect(DEFAULT_SOURCE_CLASS_WEIGHTS.project).toBe(0.7);
    expect(DEFAULT_SOURCE_CLASS_WEIGHTS.raw).toBe(0.5);
    expect(DEFAULT_SOURCE_CLASS_WEIGHTS.reference).toBe(0.3);
  });

  it('preserves the brainstorm > wiki > meeting > draft > project > raw > reference order', () => {
    const order: SourceClass[] = [
      'brainstorm',
      'wiki',
      'meeting',
      'draft',
      'project',
      'raw',
      'reference',
    ];
    for (let i = 1; i < order.length; i++) {
      const a = DEFAULT_SOURCE_CLASS_WEIGHTS[order[i - 1]!]!;
      const b = DEFAULT_SOURCE_CLASS_WEIGHTS[order[i]!]!;
      expect(a, `${order[i - 1]} should outrank ${order[i]}`).toBeGreaterThan(b);
    }
  });

  it('brainstorm outranks wiki (BF-1 ranking flip)', () => {
    expect(DEFAULT_SOURCE_CLASS_WEIGHTS.brainstorm).toBeGreaterThan(
      DEFAULT_SOURCE_CLASS_WEIGHTS.wiki,
    );
  });

  it('meeting sits between wiki and draft (BF-16)', () => {
    expect(DEFAULT_SOURCE_CLASS_WEIGHTS.meeting).toBeLessThan(
      DEFAULT_SOURCE_CLASS_WEIGHTS.wiki,
    );
    expect(DEFAULT_SOURCE_CLASS_WEIGHTS.meeting).toBeGreaterThan(
      DEFAULT_SOURCE_CLASS_WEIGHTS.draft,
    );
  });
});
