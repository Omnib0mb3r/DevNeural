/**
 * LEX-AUTONOMY codex item 7 (Fix 44) - adaptive walk-back scorer pins.
 *
 * Coverage:
 *   - scoreRef component behaviours (recency_decay, freshness, pin,
 *     supersession, failure penalty, coverage floor).
 *   - pickBundles ordering (pinned first, score-ranked second, cap at
 *     limit, coverage floor exclusion).
 *   - buildRecentErrorMap aggregation by cc_session_id, only counting
 *     "real failure" classes.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRecentErrorMap,
  pickBundles,
  scoreRef,
  WALK_BACK_DEFAULT_HALF_LIFE_MS,
  WALK_BACK_W_FRESHNESS,
  WALK_BACK_W_RECENCY,
} from '../src/lex/adaptive-walk-back.js';
import type { LexTranscriptRefRow } from '../src/store/index-db.js';

function ref(overrides: Partial<LexTranscriptRefRow>): LexTranscriptRefRow {
  return {
    id: 1,
    lex_session_id: 'anchor-a',
    cc_session_id: 'cc-a',
    transcript_path: '/tmp/cc-a.jsonl',
    started_ms: 1_000_000,
    ended_ms: 1_000_500,
    ordering: 0,
    ref_summary: null,
    ref_summary_ms: null,
    source_chunk_count: null,
    source_session_ids: null,
    coverage_score: null,
    latest_chunk_ms: null,
    pinned: 0,
    ...overrides,
  };
}

const NOW = 10_000_000;

describe('scoreRef (codex 7 components)', () => {
  it('recency_decay drops with age following exp(-age/halfLife)', () => {
    const fresh = scoreRef(
      ref({ id: 1, started_ms: NOW, latest_chunk_ms: NOW }),
      { now: NOW },
      [],
    );
    const old = scoreRef(
      ref({
        id: 2,
        started_ms: NOW - WALK_BACK_DEFAULT_HALF_LIFE_MS,
        latest_chunk_ms: NOW - WALK_BACK_DEFAULT_HALF_LIFE_MS,
      }),
      { now: NOW },
      [],
    );
    expect(fresh.recency).toBeCloseTo(1, 4);
    expect(old.recency).toBeCloseTo(Math.exp(-1), 4);
    expect(fresh.total).toBeGreaterThan(old.total);
  });

  it('freshness = 0 when ref_summary_ms is null', () => {
    const r = scoreRef(
      ref({ ref_summary_ms: null, latest_chunk_ms: NOW }),
      { now: NOW },
      [],
    );
    expect(r.freshness).toBe(0);
  });

  it('freshness peaks at 1 when summary covers the latest chunk', () => {
    const r = scoreRef(
      ref({ ref_summary_ms: NOW, latest_chunk_ms: NOW }),
      { now: NOW },
      [],
    );
    expect(r.freshness).toBeCloseTo(1, 4);
  });

  it('freshness clamps to 0 when lag exceeds the threshold', () => {
    const r = scoreRef(
      ref({
        ref_summary_ms: NOW - 600_000,
        latest_chunk_ms: NOW + 600_000,
      }),
      { now: NOW, freshnessThresholdMs: 600_000 },
      [],
    );
    expect(r.freshness).toBe(0);
  });

  it('pinned bit lights pinned=true; composite score still computed', () => {
    const r = scoreRef(
      ref({ pinned: 1, latest_chunk_ms: NOW - 1000 }),
      { now: NOW },
      [],
    );
    expect(r.pinned).toBe(true);
    expect(Number.isFinite(r.total)).toBe(true);
  });

  it('supersession fires when this ref source_session_ids subset of newer ref', () => {
    const newer = ref({
      id: 2,
      cc_session_id: 'cc-new',
      started_ms: NOW + 1_000,
      source_session_ids: JSON.stringify(['cc-a', 'cc-b']),
    });
    const older = ref({
      id: 1,
      cc_session_id: 'cc-a',
      started_ms: NOW - 1_000,
      source_session_ids: JSON.stringify(['cc-a']),
    });
    const r = scoreRef(older, { now: NOW }, [older, newer]);
    expect(r.supersession).toBe(1);
  });

  it('supersession stays 0 when no newer ref covers this set', () => {
    const a = ref({
      id: 1,
      source_session_ids: JSON.stringify(['cc-a']),
    });
    const r = scoreRef(a, { now: NOW }, [a]);
    expect(r.supersession).toBe(0);
  });

  it('failure penalty scales with recent error count, capped at 1', () => {
    const errorMap = new Map<string, number>([['cc-a', 10]]);
    const r = scoreRef(
      ref({ cc_session_id: 'cc-a' }),
      { now: NOW, recentErrorCountByCc: errorMap },
      [],
    );
    expect(r.failure).toBe(1);
  });

  it('coverage_floor excludes refs whose coverage_score < floor unless pinned', () => {
    const weak = scoreRef(
      ref({ coverage_score: 0.1, pinned: 0 }),
      { now: NOW, coverageFloor: 0.3 },
      [],
    );
    expect(weak.excluded_by_coverage).toBe(true);
    const pinned = scoreRef(
      ref({ coverage_score: 0.1, pinned: 1 }),
      { now: NOW, coverageFloor: 0.3 },
      [],
    );
    expect(pinned.excluded_by_coverage).toBe(false);
  });

  it('composite = w_recency*recency + w_freshness*freshness when no penalties', () => {
    const r = scoreRef(
      ref({
        ref_summary_ms: NOW,
        latest_chunk_ms: NOW,
        coverage_score: 1,
      }),
      { now: NOW },
      [],
    );
    /* recency ~1, freshness 1, no penalties. */
    expect(r.total).toBeCloseTo(
      WALK_BACK_W_RECENCY + WALK_BACK_W_FRESHNESS,
      4,
    );
  });
});

describe('pickBundles (codex 7 selection)', () => {
  it('returns empty when input is empty', () => {
    const r = pickBundles([], { now: NOW });
    expect(r.selected).toEqual([]);
    expect(r.ranked).toEqual([]);
  });

  it('pinned ref lands first even when much older than unpinned refs', () => {
    const oldPinned = ref({
      id: 1,
      cc_session_id: 'cc-old',
      started_ms: NOW - 5 * WALK_BACK_DEFAULT_HALF_LIFE_MS,
      latest_chunk_ms: NOW - 5 * WALK_BACK_DEFAULT_HALF_LIFE_MS,
      pinned: 1,
    });
    const freshUnpinned = ref({
      id: 2,
      cc_session_id: 'cc-fresh',
      started_ms: NOW - 1_000,
      latest_chunk_ms: NOW - 1_000,
      ref_summary_ms: NOW - 500,
    });
    const r = pickBundles([oldPinned, freshUnpinned], {
      now: NOW,
      limit: 2,
    });
    expect(r.selected.length).toBe(2);
    expect(r.selected[0]!.ref.id).toBe(1);
    expect(r.selected[0]!.reason).toBe('pinned');
    expect(r.selected[1]!.ref.id).toBe(2);
    expect(r.selected[1]!.reason).toBe('scored');
  });

  it('coverage_floor excludes weak unpinned refs', () => {
    const weak = ref({
      id: 1,
      coverage_score: 0.1,
      latest_chunk_ms: NOW - 1_000,
    });
    const ok = ref({
      id: 2,
      cc_session_id: 'cc-ok',
      coverage_score: 0.6,
      latest_chunk_ms: NOW - 1_000,
    });
    const r = pickBundles([weak, ok], { now: NOW, limit: 5 });
    expect(r.selected.map((s) => s.ref.id)).toEqual([2]);
  });

  it('higher score wins among unpinned refs', () => {
    const stale = ref({
      id: 1,
      cc_session_id: 'cc-stale',
      latest_chunk_ms: NOW - 1_000,
      ref_summary_ms: NOW - 10 * 600_000, // far past freshness threshold
    });
    const fresh = ref({
      id: 2,
      cc_session_id: 'cc-fresh',
      latest_chunk_ms: NOW - 1_000,
      ref_summary_ms: NOW - 1_000,
    });
    const r = pickBundles([stale, fresh], { now: NOW, limit: 5 });
    expect(r.selected[0]!.ref.id).toBe(2);
  });

  it('cap at limit; surplus refs land in ranked but not selected', () => {
    const refs: LexTranscriptRefRow[] = [];
    for (let i = 0; i < 7; i++) {
      refs.push(
        ref({
          id: i + 1,
          cc_session_id: `cc-${i}`,
          latest_chunk_ms: NOW - i * 60_000,
        }),
      );
    }
    const r = pickBundles(refs, { now: NOW, limit: 5 });
    expect(r.selected.length).toBe(5);
    expect(r.ranked.length).toBe(7);
  });

  it('failure penalty deprioritises a ref with recent errors', () => {
    const errorMap = new Map<string, number>([['cc-flaky', 5]]);
    const flaky = ref({
      id: 1,
      cc_session_id: 'cc-flaky',
      latest_chunk_ms: NOW - 1_000,
      ref_summary_ms: NOW - 1_000,
    });
    const clean = ref({
      id: 2,
      cc_session_id: 'cc-clean',
      latest_chunk_ms: NOW - 1_000,
      ref_summary_ms: NOW - 1_000,
    });
    const r = pickBundles([flaky, clean], {
      now: NOW,
      limit: 5,
      recentErrorCountByCc: errorMap,
    });
    expect(r.selected[0]!.ref.id).toBe(2);
  });
});

describe('buildRecentErrorMap (codex 7 aggregator)', () => {
  it('counts only provider_threw and empty_llm_reply rows per cc_session_id', () => {
    const rows = [
      { cc_session_id: 'cc-1', error_class: 'provider_threw' },
      { cc_session_id: 'cc-1', error_class: 'empty_llm_reply' },
      { cc_session_id: 'cc-1', error_class: 'no_provider' }, // skipped
      { cc_session_id: 'cc-2', error_class: 'provider_threw' },
      { cc_session_id: null, error_class: 'provider_threw' }, // skipped
    ];
    const m = buildRecentErrorMap(rows);
    expect(m.get('cc-1')).toBe(2);
    expect(m.get('cc-2')).toBe(1);
    expect(m.size).toBe(2);
  });

  it('returns empty map when input has no countable rows', () => {
    const rows = [
      { cc_session_id: 'cc-1', error_class: 'no_session_scoped_chunks' },
      { cc_session_id: 'cc-1', error_class: 'bf4_anthropic_blocked' },
    ];
    const m = buildRecentErrorMap(rows);
    expect(m.size).toBe(0);
  });
});
