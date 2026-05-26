/* TODO codex 8 follow-up:
 *   - Route wire: extend POST /worker/clear-handoff to optionally
 *     return the worker-boot-render block alongside the legacy
 *     sections; gated behind a runtime_config flag so the first ship
 *     stays additive.
 *   - Cold-start preload alignment: have summarizeFromAnchor call
 *     buildSourceGraphPayload directly (currently it duplicates the
 *     pickBundles call); no output change expected; deferred to avoid
 *     scope creep in this commit.
 *   - Tests pinning renderWorkerBoot output shape across modes
 *     (smart-clear vs first-attach). Skeleton in place; full
 *     coverage lands in the codex 9 ship.
 */
/**
 * Worker boot render (LEX-AUTONOMY codex item 8 / Fix 45).
 *
 * Action-first render shape consumed by the worker handoff route. Same
 * SourcePayload primitive feeds the cold-start preload's markdown
 * render (Lex side) and this terse worker-side block.
 *
 * Section order:
 *   1. Header line (anchor + active spec hint + first-attach marker)
 *   2. Your next action (Lex-authored, or FIRST-ATTACH placeholder)
 *   3. Bundles (top-K refs with summary slice + staleness tag +
 *      last 3 turn pairs)
 *   4. Recent distillation errors (count + class names, if any)
 *   5. Footer reminder (worker-status-footer protocol from
 *      worker-handoff.ts)
 *
 * Deterministic: no Date.now() in the output. Relative-age strings
 * read from the SourcePayload's frozen timestamps.
 */
import type { SourcePayload } from './source-graph-payload.js';

export interface RenderWorkerBootOptions {
  /** smart-clear: worker /clear'd, Lex resume summary is paired; the
   *               render carries no "next action" line because the
   *               paired paste IS the next action.
   * first-attach: brand-new worker spawn; render emits FIRST-ATTACH
   *               or nextAction string in the action line. */
  mode: 'smart-clear' | 'first-attach';
  /** Lex-authored next-action sentence. Optional; smart-clear leaves
   * it blank, first-attach defaults to "FIRST-ATTACH" when null. */
  nextAction?: string | null;
  /** Frozen clock; relative-age tags ("STALE 14h") compute against
   * this. */
  now: number;
  /** Cap on rendered ref_summary chars per bundle. Default 800. */
  summaryCharCap?: number;
  /** Cap on turn pairs rendered per bundle. Default 3. */
  pairsPerBundle?: number;
}

const DEFAULT_SUMMARY_CHAR_CAP = 800;
const DEFAULT_PAIRS_PER_BUNDLE = 3;

function humanAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

function ageTag(
  ref: SourcePayload['refs'][number],
  now: number,
): string {
  const tags: string[] = [];
  if (ref.is_stale && ref.latest_chunk_ms !== null) {
    tags.push(`STALE ${humanAgo(now - ref.latest_chunk_ms)}`);
  }
  if (ref.pinned) tags.push('pinned');
  return tags.length > 0 ? ` [${tags.join(', ')}]` : '';
}

function clipSummary(text: string, cap: number): string {
  if (text.length <= cap) return text.trim();
  return text.slice(0, cap - 1).trimEnd() + '…';
}

export function renderWorkerBoot(
  payload: SourcePayload,
  opts: RenderWorkerBootOptions,
): string {
  const summaryCap = opts.summaryCharCap ?? DEFAULT_SUMMARY_CHAR_CAP;
  const pairsCap = opts.pairsPerBundle ?? DEFAULT_PAIRS_PER_BUNDLE;
  const lines: string[] = [];

  /* Header. Anchor name first, then first-attach marker so the worker
   * can spot "fresh" without parsing the whole block. */
  const label =
    payload.anchor.user_label ??
    payload.anchor.derived_label ??
    payload.anchor.id.slice(0, 12);
  const headerTags: string[] = [];
  if (payload.first_attach) headerTags.push('FIRST-ATTACH');
  if (payload.staleness_state === 'all_stale') headerTags.push('all-refs-stale');
  else if (payload.staleness_state === 'partial_stale')
    headerTags.push('partial-stale');
  const headerTagStr =
    headerTags.length > 0 ? ` [${headerTags.join(', ')}]` : '';
  lines.push(`# Worker handoff: ${label}${headerTagStr}`);
  lines.push('');

  /* Next action - first because action precedes context. smart-clear
   * mode emits a placeholder line pointing at the paired resume paste;
   * first-attach mode emits the Lex-authored directive or the literal
   * FIRST-ATTACH marker. */
  lines.push('## Your next action');
  if (opts.mode === 'first-attach') {
    const action =
      opts.nextAction && opts.nextAction.trim().length > 0
        ? opts.nextAction.trim()
        : 'FIRST-ATTACH - await Lex directive before acting.';
    lines.push(action);
  } else if (opts.nextAction && opts.nextAction.trim().length > 0) {
    lines.push(opts.nextAction.trim());
  } else {
    lines.push(
      'See the paired resume paste from Lex for the directive (smart-clear path; Lex authors the next action on the same turn).',
    );
  }
  lines.push('');

  /* Bundles - the corpus-projected slice. Action-oriented header so
   * the worker scans the bundle list as "prior context", not as
   * "another wall of text". */
  lines.push(
    `## Bundles (${payload.refs.length} of ${payload.freshness.total} surfaced; fresh=${payload.freshness.fresh}, stale=${payload.freshness.stale})`,
  );
  if (payload.refs.length === 0) {
    if (payload.first_attach) {
      lines.push(
        '- (no prior sessions on this anchor; worker is the first attached process)',
      );
    } else {
      lines.push('- (no prior refs available for this anchor)');
    }
  } else {
    for (let i = 0; i < payload.refs.length; i++) {
      const r = payload.refs[i]!;
      const reasonTag = r.reason === 'pinned' ? ' [pinned]' : '';
      const tag = ageTag(r, opts.now);
      const cc = r.cc_session_id.slice(0, 8);
      const cov =
        r.coverage_score === null
          ? ''
          : ` cov=${r.coverage_score.toFixed(2)}`;
      lines.push(
        `### Bundle ${i + 1} (cc:${cc}, ordering ${r.ordering}${cov})${reasonTag}${tag}`,
      );
      if (r.ref_summary) {
        lines.push(clipSummary(r.ref_summary, summaryCap));
      } else {
        lines.push('(no distillation yet)');
      }
      if (r.turn_pairs.length > 0) {
        const slice = r.turn_pairs.slice(-pairsCap * 2);
        lines.push('Recent turns:');
        for (const t of slice) {
          const role = t.role === 'user' ? 'user' : 'lex';
          lines.push(`- ${role}: ${clipSummary(t.text, 240)}`);
        }
      }
    }
  }
  lines.push('');

  /* Recent distillation errors. Surfaced only when present so the
   * happy path stays compact. */
  if (payload.recent_errors.length > 0) {
    lines.push(`## Recent distillation errors (${payload.recent_errors.length})`);
    for (const e of payload.recent_errors) {
      const cc = e.cc_session_id ? `cc:${e.cc_session_id.slice(0, 8)}` : 'cc:?';
      lines.push(`- ${e.error_class} on ${cc} at ${e.ts}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
