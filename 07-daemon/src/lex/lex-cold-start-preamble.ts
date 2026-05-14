/**
 * Cold-start preamble assembler + race-free force-distill helper.
 *
 * The cold-start preload route used to call buildSiblingIndex straight
 * against whatever last_summary rows happened to be present, which
 * meant a fresh Lex session booted with stale or missing
 * distillations whenever the steady-state cron had not yet caught up
 * to the just-ended sibling (the user's typical "Lex compacted 30s
 * ago, click new session" flow). preloadColdStartSiblings closes that
 * race: it calls preloadSiblingDistillations synchronously with a
 * top-N force window so the most-recent siblings always have current
 * last_summary rows before buildSiblingIndex reads them.
 *
 * The same call returns enough metadata for two of the three
 * visibility layers spec'd alongside the compaction work:
 *
 *   - first-turn Lex preamble: a one-liner like "Loaded 4 sibling
 *     sessions, last distilled 14:32 EDT, 12 recent turns appended."
 *     that Lex prints verbatim on its first reply so the user reads
 *     immediately what context primed.
 *   - brainstorm header status row: a tiny pill in the brainstorm UI
 *     showing "context: N siblings + M turns" or "context: failed
 *     (reason)" depending on the preload outcome.
 *
 * Pure module: every side effect (LLM call, db write, clock) flows
 * through injected dependencies so tests can drive the race-fix
 * branches without touching ollama or the real db.
 */
import type { BrainstormSessionRow, IndexDb } from '../store/index-db.js';
import {
  preloadSiblingDistillations,
  type DistillationGenerator,
  type PreloadResult,
} from './sibling-distillation-preload.js';

export interface ColdStartPreloadInput {
  db: IndexDb;
  /** Generator that calls the local-only LLM provider to produce a
   * distillation. Required when force_for_top_n > 0; null disables
   * the synchronous force pass and falls back to "use whatever
   * last_summary rows already exist". */
  generator: DistillationGenerator | null;
  /** New session's user_label (the join key for siblings). */
  label: string | null | undefined;
  /** New session id; excluded from the sibling set. */
  excludeId: string | null;
  /** Synchronously force-distill the top N siblings if their
   * last_summary is missing. Defaults to 2 (the spec's "preload
   * covers the top 2 most-recent siblings"). Set to 0 to disable
   * the race-fix pass; the existing steady-state cron is then
   * responsible for keeping siblings current. */
  forceForTopN?: number;
  /** Clock for the last_summary_ms stamp on force-distilled rows. */
  now?: () => number;
}

export interface ColdStartPreloadSummary {
  /** Same buckets the underlying preloader returns. */
  preload: PreloadResult;
  /** Count of sibling rows actually surfaced (preloaded + already
   * present), capped at the limit. The header pill renders this. */
  sibling_count: number;
  /** ms-since-epoch of the most recent last_summary_ms on any
   * surfaced sibling. null when no siblings have a distillation
   * yet. The first-turn preamble formats this as HH:MM local. */
  last_distilled_ms: number | null;
  /** Total brainstorm_chunks rows across the surfaced siblings.
   * Renders in the preamble as "M recent turns appended". */
  recent_turns_appended: number;
  /** When the preload could not complete cleanly (no label, no
   * siblings, generator threw before any work, etc.) the failure
   * reason rides here so the header pill can render "context:
   * failed (no-label)". null on success. */
  failure_reason: string | null;
}

const TOP_N_DEFAULT = 2;

export async function preloadColdStartSiblings(
  input: ColdStartPreloadInput,
): Promise<ColdStartPreloadSummary> {
  const out: ColdStartPreloadSummary = {
    preload: { preloaded: [], skipped: [], already_present: [] },
    sibling_count: 0,
    last_distilled_ms: null,
    recent_turns_appended: 0,
    failure_reason: null,
  };
  const label = (input.label ?? '').trim();
  if (!label) {
    out.failure_reason = 'no-label';
    return out;
  }
  const forceN = input.forceForTopN ?? TOP_N_DEFAULT;
  const now = input.now ?? Date.now;

  /* Race-fix pass: synchronously distill the top-N siblings whose
   * last_summary is still null. preloadSiblingDistillations is the
   * existing entry point - it already awaits each generator call,
   * so this is the canonical "wait for completion" mode. Skipping
   * the pass entirely when generator===null or forceN===0 keeps the
   * shape backward-compatible for callers that don't care about
   * race resolution. */
  if (forceN > 0 && input.generator) {
    try {
      out.preload = await preloadSiblingDistillations({
        db: input.db,
        label,
        excludeId: input.excludeId ?? null,
        generator: input.generator,
        limit: forceN,
        now,
      });
    } catch (err) {
      out.failure_reason = `preload-threw: ${(err as Error).message}`;
      return out;
    }
  }

  /* Pull the surfaced sibling rows: same label, excluding the new
   * session, top-N by started_ms. The preloader doesn't return the
   * full rows so we re-query rather than thread them through the
   * dependency surface. listBrainstorms is DESC by started_ms. */
  const allRows = input.db.listBrainstorms({ limit: 200 });
  const target = label.toLowerCase();
  const siblings = allRows.filter((r) => {
    if (input.excludeId && r.id === input.excludeId) return false;
    return (r.user_label ?? '').trim().toLowerCase() === target;
  });
  const surfaced = siblings.slice(0, forceN > 0 ? Math.max(forceN, 5) : 5);
  out.sibling_count = surfaced.length;

  if (surfaced.length === 0) {
    out.failure_reason = 'no-siblings';
    return out;
  }

  let maxDistilledMs: number | null = null;
  let turns = 0;
  for (const row of surfaced) {
    if (row.last_summary_ms && row.last_summary_ms > 0) {
      if (maxDistilledMs === null || row.last_summary_ms > maxDistilledMs) {
        maxDistilledMs = row.last_summary_ms;
      }
    }
    try {
      turns += input.db.countBrainstormChunks(row.id);
    } catch {
      /* observational; count is a UI surface, never block preload */
    }
  }
  out.last_distilled_ms = maxDistilledMs;
  out.recent_turns_appended = turns;
  return out;
}

/* Format the first-turn preamble Lex prints verbatim on its first
 * reply. Auto-generated, not LLM-decided, so the user can trust the
 * counts. Examples:
 *   "Loaded 4 sibling sessions, last distilled 14:32 EDT, 12 recent
 *    turns appended."
 *   "Loaded 1 sibling session, distillation not yet available, 3
 *    recent turns appended."
 *   "Cold start: no prior sibling sessions found." */
export interface FormatPreambleOptions {
  /** TZ-aware label for the distilled timestamp. Defaults to
   * Intl.DateTimeFormat's resolved timezone short name. Tests
   * inject a fixed string so the formatting stays deterministic. */
  timeZoneTag?: string;
  /** Clock for "now" reference (unused today, reserved for future
   * "X minutes ago" formatting). */
  now?: () => Date;
}

export function formatColdStartPreamble(
  summary: ColdStartPreloadSummary,
  opts: FormatPreambleOptions = {},
): string {
  if (summary.sibling_count === 0) {
    return 'Cold start: no prior sibling sessions found.';
  }
  const word = summary.sibling_count === 1 ? 'session' : 'sessions';
  const head = `Loaded ${summary.sibling_count} sibling ${word}`;
  let distilled: string;
  if (summary.last_distilled_ms === null) {
    distilled = 'distillation not yet available';
  } else {
    const d = new Date(summary.last_distilled_ms);
    const tz = opts.timeZoneTag ?? defaultTimeZoneTag();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    distilled = `last distilled ${hh}:${mm}${tz ? ' ' + tz : ''}`;
  }
  const turnWord = summary.recent_turns_appended === 1 ? 'turn' : 'turns';
  const turns = `${summary.recent_turns_appended} recent ${turnWord} appended`;
  return `${head}, ${distilled}, ${turns}.`;
}

function defaultTimeZoneTag(): string {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' });
    const parts = fmt.formatToParts(new Date());
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    return tz;
  } catch {
    return '';
  }
}

/* Header status pill copy. Surfaces in the brainstorm UI's header
 * row and reads identically whether the preload succeeded or failed
 * - a red treatment is left to the caller via the failure_reason
 * field. */
export function formatHeaderStatus(
  summary: ColdStartPreloadSummary,
): { tone: 'ok' | 'err'; text: string } {
  if (summary.failure_reason) {
    return {
      tone: 'err',
      text: `context: failed (${summary.failure_reason})`,
    };
  }
  return {
    tone: 'ok',
    text: `context: ${summary.sibling_count} siblings + ${summary.recent_turns_appended} turns`,
  };
}

/* Stable JSON-serializable shape for the preload event log surfaced
 * in LexColdStartPreloadPanel. The dashboard groups by brainstorm_id
 * so the panel can render one collapsible card per concurrent
 * session even when several brainstorms are running at the same
 * time. */
export interface PreloadEventLogRow {
  ts: string;
  brainstorm_id: string;
  cc_session_id: string | null;
  sibling_count: number;
  last_distilled_ms: number | null;
  recent_turns_appended: number;
  preloaded_ids: string[];
  already_present_ids: string[];
  failure_reason: string | null;
  preamble: string;
}

export function buildPreloadEventLogRow(input: {
  brainstormId: string;
  ccSessionId: string | null;
  summary: ColdStartPreloadSummary;
  preamble: string;
  ts?: string;
}): PreloadEventLogRow {
  return {
    ts: input.ts ?? new Date().toISOString(),
    brainstorm_id: input.brainstormId,
    cc_session_id: input.ccSessionId,
    sibling_count: input.summary.sibling_count,
    last_distilled_ms: input.summary.last_distilled_ms,
    recent_turns_appended: input.summary.recent_turns_appended,
    preloaded_ids: input.summary.preload.preloaded.slice(),
    already_present_ids: input.summary.preload.already_present.slice(),
    failure_reason: input.summary.failure_reason,
    preamble: input.preamble,
  };
}

/* Cap the in-memory preload log so a long-running daemon does not
 * unbounded-grow when the panel pings the endpoint. The cap is
 * intentionally generous (500 events) so the panel can group by
 * brainstorm_id and still surface enough history per session. */
export const PRELOAD_EVENT_LOG_CAP = 500;

const preloadEventLog: PreloadEventLogRow[] = [];

/** Append an event row. Called by the cold-start route after the
 * preload completes so the dashboard panel can read it. */
export function recordPreloadEvent(row: PreloadEventLogRow): void {
  preloadEventLog.push(row);
  if (preloadEventLog.length > PRELOAD_EVENT_LOG_CAP) {
    preloadEventLog.splice(0, preloadEventLog.length - PRELOAD_EVENT_LOG_CAP);
  }
}

/** Read the event log, optionally filtered by brainstorm_id so the
 * dashboard can render one card per concurrent session. Returns the
 * most-recent rows first. */
export function listPreloadEvents(opts: {
  brainstormId?: string | null;
  limit?: number;
} = {}): PreloadEventLogRow[] {
  const limit = opts.limit ?? 50;
  const filtered = opts.brainstormId
    ? preloadEventLog.filter((r) => r.brainstorm_id === opts.brainstormId)
    : preloadEventLog.slice();
  return filtered.reverse().slice(0, limit);
}

/** Group all in-memory events by brainstorm_id so the panel can
 * render a multi-session view without re-grouping client-side. */
export function groupPreloadEventsBySession(opts: {
  perSessionLimit?: number;
} = {}): Array<{
  brainstorm_id: string;
  cc_session_id: string | null;
  rows: PreloadEventLogRow[];
}> {
  const perLimit = opts.perSessionLimit ?? 20;
  const groups = new Map<
    string,
    {
      brainstorm_id: string;
      cc_session_id: string | null;
      rows: PreloadEventLogRow[];
    }
  >();
  /* Walk most-recent first so the cc_session_id we surface is the
   * latest known binding for that brainstorm. */
  for (let i = preloadEventLog.length - 1; i >= 0; i--) {
    const row = preloadEventLog[i]!;
    const existing = groups.get(row.brainstorm_id);
    if (existing) {
      if (existing.rows.length < perLimit) existing.rows.push(row);
    } else {
      groups.set(row.brainstorm_id, {
        brainstorm_id: row.brainstorm_id,
        cc_session_id: row.cc_session_id,
        rows: [row],
      });
    }
  }
  return Array.from(groups.values());
}

/** Test seam: clear the in-memory event log between tests. Not
 * exposed via the public surface in production. */
export function _resetPreloadEventLog(): void {
  preloadEventLog.length = 0;
}

/* Surfaced separately so tests can pin the surrounding row shape
 * even without a real brainstorm row. */
export function pickSurfacedSiblings(
  rows: BrainstormSessionRow[],
  label: string,
  excludeId: string | null,
  limit: number,
): BrainstormSessionRow[] {
  const target = label.trim().toLowerCase();
  if (!target) return [];
  const out: BrainstormSessionRow[] = [];
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    if ((row.user_label ?? '').trim().toLowerCase() !== target) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}
