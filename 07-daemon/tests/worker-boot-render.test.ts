/**
 * Codex item 8 (Fix 45) - renderWorkerBoot test pins.
 *
 * Covers smart-clear shape, first-attach shape, staleness tag,
 * recent_errors rendering, determinism (two calls deep-equal),
 * summaryCharCap + pairsPerBundle behavior.
 */
import { describe, expect, it } from 'vitest';
import { renderWorkerBoot } from '../src/lex/worker-boot-render.js';
import type { SourcePayload } from '../src/lex/source-graph-payload.js';

const NOW = 10_000_000;

function basePayload(overrides?: Partial<SourcePayload>): SourcePayload {
  return {
    anchor: {
      id: 'anchor-test',
      user_label: 'codex8',
      derived_label: null,
      last_summary: null,
      last_summary_ms: null,
    },
    refs: [],
    freshness: { total: 0, fresh: 0, stale: 0, oldest_stale_ms: null },
    staleness_state: 'no_refs',
    recent_errors: [],
    first_attach: false,
    not_found: false,
    ...overrides,
  };
}

function bundle(over: Partial<SourcePayload['refs'][number]>): SourcePayload['refs'][number] {
  return {
    ref_id: 1,
    cc_session_id: 'cc-abcdef1234',
    ordering: 0,
    started_ms: NOW - 5000,
    ended_ms: NOW - 4000,
    ref_summary: 'fresh summary',
    ref_summary_ms: NOW - 4000,
    coverage_score: 0.8,
    latest_chunk_ms: NOW - 4000,
    is_stale: false,
    pinned: false,
    score: {
      recency: 1,
      freshness: 1,
      supersession: 0,
      failure: 0,
      pinned: false,
      excluded_by_coverage: false,
      total: 0.8,
    },
    reason: 'scored',
    turn_pairs: [],
    ...over,
  };
}

describe('renderWorkerBoot (Fix 45)', () => {
  it('smart-clear shape: no nextAction line content; defers to paired paste', () => {
    const payload = basePayload({
      refs: [bundle({})],
      freshness: { total: 1, fresh: 1, stale: 0, oldest_stale_ms: null },
      staleness_state: 'all_fresh',
    });
    const out = renderWorkerBoot(payload, { mode: 'smart-clear', now: NOW });
    expect(out).toContain('# Worker handoff: codex8');
    expect(out).toContain('## Your next action');
    expect(out).toContain('See the paired resume paste');
    expect(out).not.toContain('FIRST-ATTACH');
  });

  it('first-attach shape: nextAction shows FIRST-ATTACH when null', () => {
    const payload = basePayload({ first_attach: true });
    const out = renderWorkerBoot(payload, { mode: 'first-attach', now: NOW });
    expect(out).toContain('[FIRST-ATTACH]');
    expect(out).toContain('FIRST-ATTACH - await Lex directive');
  });

  it('first-attach shape: nextAction shows Lex-supplied sentence when provided', () => {
    const payload = basePayload({ first_attach: true });
    const out = renderWorkerBoot(payload, {
      mode: 'first-attach',
      now: NOW,
      nextAction: 'Run smoke tests before committing.',
    });
    expect(out).toContain('Run smoke tests before committing.');
    expect(out).not.toContain('FIRST-ATTACH - await Lex directive');
  });

  it('staleness tag renders STALE Nh for refs flagged stale', () => {
    const staleRef = bundle({
      is_stale: true,
      latest_chunk_ms: NOW - 14 * 3_600_000, // 14h
    });
    const payload = basePayload({
      refs: [staleRef],
      freshness: { total: 1, fresh: 0, stale: 1, oldest_stale_ms: staleRef.latest_chunk_ms },
      staleness_state: 'all_stale',
    });
    const out = renderWorkerBoot(payload, { mode: 'smart-clear', now: NOW });
    expect(out).toContain('STALE 14h');
    expect(out).toContain('all-refs-stale');
  });

  it('renders recent_errors when present and omits the section otherwise', () => {
    const empty = renderWorkerBoot(basePayload({}), { mode: 'smart-clear', now: NOW });
    expect(empty).not.toContain('Recent distillation errors');
    const withErr = renderWorkerBoot(
      basePayload({
        recent_errors: [
          {
            id: 'e1',
            ts: '2026-05-26T05:00:00.000Z',
            cc_session_id: 'cc-deadbeef',
            error_class: 'provider_threw',
            error_message: null,
          },
        ],
      }),
      { mode: 'smart-clear', now: NOW },
    );
    expect(withErr).toContain('## Recent distillation errors (1)');
    expect(withErr).toContain('provider_threw on cc:cc-deadb');
  });

  it('determinism: same payload + opts produce identical bytes across two calls', () => {
    const payload = basePayload({
      refs: [bundle({ ref_summary: 'x'.repeat(100) })],
      freshness: { total: 1, fresh: 1, stale: 0, oldest_stale_ms: null },
      staleness_state: 'all_fresh',
    });
    const opts = { mode: 'smart-clear' as const, now: NOW };
    expect(renderWorkerBoot(payload, opts)).toBe(renderWorkerBoot(payload, opts));
  });

  it('summaryCharCap truncates with ellipsis', () => {
    const big = bundle({ ref_summary: 'x'.repeat(2000) });
    const out = renderWorkerBoot(basePayload({ refs: [big] }), {
      mode: 'smart-clear',
      now: NOW,
      summaryCharCap: 50,
    });
    expect(out).toMatch(/x{40,49}…/);
  });

  it('pairsPerBundle caps turn count in output', () => {
    const ref = bundle({
      turn_pairs: [
        { role: 'user', text: 'u1' },
        { role: 'assistant', text: 'a1' },
        { role: 'user', text: 'u2' },
        { role: 'assistant', text: 'a2' },
        { role: 'user', text: 'u3' },
        { role: 'assistant', text: 'a3' },
        { role: 'user', text: 'u4' },
        { role: 'assistant', text: 'a4' },
      ],
    });
    const out = renderWorkerBoot(basePayload({ refs: [ref] }), {
      mode: 'smart-clear',
      now: NOW,
      pairsPerBundle: 2,
    });
    /* pairsPerBundle=2 means last 2 pairs = last 4 turns (u3,a3,u4,a4).
     * Earlier turns (u1,a1,u2,a2) should NOT appear. */
    expect(out).toContain('u4');
    expect(out).toContain('a4');
    expect(out).not.toContain('u1');
    expect(out).not.toContain('a1');
  });
});
