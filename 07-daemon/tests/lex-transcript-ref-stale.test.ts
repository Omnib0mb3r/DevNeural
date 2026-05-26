/**
 * LEX-AUTONOMY codex item 5 - staleness derivation pin.
 *
 * Unit tests for isRefStale + summarizeRefStaleness. The rules under
 * test mirror what migration 041 + the cold-start preload sync barrier
 * rely on. Any change in the predicate must update both this file and
 * the migration header doc.
 */
import { describe, expect, it } from 'vitest';
import {
  isRefStale,
  summarizeRefStaleness,
} from '../src/lex/lex-transcript-ref.js';
import type { LexTranscriptRefRow } from '../src/store/index-db.js';

function refRow(overrides: Partial<LexTranscriptRefRow>): LexTranscriptRefRow {
  return {
    id: 1,
    lex_session_id: 'brainstorm-a',
    cc_session_id: 'cc-a',
    transcript_path: '/tmp/cc-a.jsonl',
    started_ms: 1,
    ended_ms: null,
    ordering: 0,
    ref_summary: null,
    ref_summary_ms: null,
    source_chunk_count: null,
    source_session_ids: null,
    coverage_score: null,
    latest_chunk_ms: null,
    ...overrides,
  };
}

describe('isRefStale (codex item 5)', () => {
  it('returns false when latest_chunk_ms is null (no chunks observed yet)', () => {
    expect(isRefStale(refRow({ latest_chunk_ms: null }))).toBe(false);
  });

  it('returns false when both latest_chunk_ms and ref_summary_ms are null', () => {
    expect(
      isRefStale(refRow({ latest_chunk_ms: null, ref_summary_ms: null })),
    ).toBe(false);
  });

  it('returns true when ref_summary_ms is null AND latest_chunk_ms is non-null (never distilled)', () => {
    expect(
      isRefStale(refRow({ latest_chunk_ms: 1000, ref_summary_ms: null })),
    ).toBe(true);
  });

  it('returns true when latest_chunk_ms > ref_summary_ms (new chunks since distill)', () => {
    expect(
      isRefStale(refRow({ latest_chunk_ms: 2000, ref_summary_ms: 1500 })),
    ).toBe(true);
  });

  it('returns false when latest_chunk_ms === ref_summary_ms (distill saw the latest chunk)', () => {
    expect(
      isRefStale(refRow({ latest_chunk_ms: 2000, ref_summary_ms: 2000 })),
    ).toBe(false);
  });

  it('returns false when latest_chunk_ms < ref_summary_ms (distill ran after the last chunk)', () => {
    expect(
      isRefStale(refRow({ latest_chunk_ms: 1500, ref_summary_ms: 2000 })),
    ).toBe(false);
  });
});

describe('summarizeRefStaleness (codex item 5)', () => {
  it('counts fresh + stale across a mixed input', () => {
    const refs = [
      refRow({ id: 1, latest_chunk_ms: 100, ref_summary_ms: 50 }), // stale
      refRow({ id: 2, latest_chunk_ms: 200, ref_summary_ms: 200 }), // fresh
      refRow({ id: 3, latest_chunk_ms: null, ref_summary_ms: null }), // fresh
      refRow({ id: 4, latest_chunk_ms: 300, ref_summary_ms: null }), // stale
    ];
    const r = summarizeRefStaleness(refs);
    expect(r.total).toBe(4);
    expect(r.stale).toBe(2);
    expect(r.fresh).toBe(2);
  });

  it('reports zeroes on empty input', () => {
    const r = summarizeRefStaleness([]);
    expect(r).toEqual({ total: 0, stale: 0, fresh: 0 });
  });
});
