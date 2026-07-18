/**
 * Grooming pass runtime (Phase 2 of LEX-STANDALONE-SUPERVISION).
 *
 * Four pass kinds, escalating:
 *   light    chunks rollup + last_summary refresh if >=10 new turns
 *   mid      light + arc distillation + thread-doc refresh
 *   cold     mid + full HANDOVER artifact on disk
 *   day-cap  cold + flip lifecycle_state='ended' + run final
 *            distillation via the existing session-end-pipeline
 *
 * Each pass updates `last_grooming_pass_at` and `last_grooming_kind`
 * on the brainstorm row when it completes (success OR partial). The
 * idle-watcher uses those columns to avoid re-firing the same pass
 * twice without an intervening user utterance.
 *
 * Pure module aside from injected dependencies. Tests pin every
 * branch with stubs; production wires real db / LLM / disk.
 */
import type { BrainstormSessionRow, IndexDb } from '../store/index-db.js';
import type { DistillationGenerator } from './sibling-distillation-preload.js';
import type { HandoverPayload } from './handover-writer.js';

export type GroomingKind = 'light' | 'mid' | 'cold' | 'day-cap';

export const GROOMING_KIND_RANK: Record<GroomingKind, number> = {
  light: 1,
  mid: 2,
  cold: 3,
  'day-cap': 4,
};

export interface GroomingDeps {
  db: IndexDb;
  /** LLM-driven generator for the rolling summary refresh. The same
   * generator the session-end-pipeline uses. */
  generator?: DistillationGenerator;
  /** Disk write for cold + day-cap passes. */
  writeHandover?: (payload: HandoverPayload) => { filePath: string; bytes: number };
  /** Final distillation for the day-cap pass (delegates to the
   * existing session-end-pipeline). */
  runFinalDistillation?: (brainstormId: string) => Promise<void>;
  /** Clock seam for tests. */
  now?: () => number;
  log?: (msg: string) => void;
}

export interface GroomingResult {
  kind: GroomingKind;
  brainstormId: string;
  ran_at: string;
  /* Per-step outcomes; null when the step was a no-op for this kind. */
  rolling_summary_written: boolean | null;
  handover_written: boolean | null;
  handover_path: string | null;
  ended_at_day_cap: boolean | null;
  errors: string[];
}

const MIN_NEW_TURNS_FOR_SUMMARY = 10;
const RECENT_TURNS_FOR_HANDOVER = 12;

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

/* Threshold table from the spec. Values are ms from the last user
 * utterance. Exposed so the idle-watcher imports the same numbers. */
export const GROOMING_THRESHOLDS_MS: Record<GroomingKind, number> = {
  light: 5 * 60 * 1000,
  mid: 20 * 60 * 1000,
  cold: 60 * 60 * 1000,
  'day-cap': 6 * 60 * 60 * 1000,
};

export interface PendingPassDecision {
  /** The highest-tier pass that should run, or null when nothing is
   * due. */
  kind: GroomingKind | null;
  /** Computed silence interval in ms (now - baseline). Surface for
   * logging / dashboard. */
  silenceMs: number;
  /** Baseline timestamp the silence was computed against. Either
   * last_user_utterance_at or started_ms when no user turn has ever
   * landed. ms epoch. */
  baselineMs: number;
}

/* Decide which grooming pass (if any) is due for a row at instant
 * `now`. Encodes the spec's escalation rules + the "do not re-fire
 * the same level since the last utterance" guard. Pure function so
 * the idle-watcher tests can pin every branch without standing up
 * the runtime. */
export function decidePendingPass(
  row: BrainstormSessionRow,
  now: number,
): PendingPassDecision {
  if (row.lifecycle_state === 'speaking') {
    return { kind: null, silenceMs: 0, baselineMs: now };
  }
  if (row.lifecycle_state === 'ended') {
    return { kind: null, silenceMs: 0, baselineMs: now };
  }
  const baselineMs = row.last_user_utterance_at
    ? Date.parse(row.last_user_utterance_at)
    : (row.started_ms ?? now);
  const silenceMs = Math.max(0, now - baselineMs);
  let candidate: GroomingKind | null = null;
  /* Walk kinds from cheapest to most expensive; keep the highest the
   * silence has crossed. */
  for (const k of ['light', 'mid', 'cold', 'day-cap'] as GroomingKind[]) {
    if (silenceMs >= GROOMING_THRESHOLDS_MS[k]) candidate = k;
  }
  if (!candidate) {
    return { kind: null, silenceMs, baselineMs };
  }
  /* Idempotency guard. If a pass of the same OR higher rank already
   * ran AFTER the baseline, skip. The next user utterance resets the
   * baseline and re-arms every threshold. */
  if (row.last_grooming_kind && row.last_grooming_pass_at) {
    const lastRank = GROOMING_KIND_RANK[row.last_grooming_kind];
    const candidateRank = GROOMING_KIND_RANK[candidate];
    const lastRanMs = Date.parse(row.last_grooming_pass_at);
    if (
      Number.isFinite(lastRanMs) &&
      lastRanMs >= baselineMs &&
      lastRank >= candidateRank
    ) {
      return { kind: null, silenceMs, baselineMs };
    }
  }
  return { kind: candidate, silenceMs, baselineMs };
}

/* Count brainstorm_chunks rows for a brainstorm whose turn_index
 * lands after the most recent (turn_index, last_summary_ms)-style
 * watermark we have. Approximation: if last_summary_ms is null,
 * everything counts; otherwise compare against turn_count at last
 * summary time. The watermark is intentionally loose because the
 * spec only requires "more than 10 new turns since last write" as
 * a heuristic to decide whether the rolling summary is stale. */
function newTurnsSinceLastSummary(
  db: IndexDb,
  row: BrainstormSessionRow,
): number {
  const all = db.listBrainstormChunks(row.id, 2000);
  if (!row.last_summary_ms) return all.length;
  /* Without a per-chunk created_at index, fall back to "everything
   * after the last_summary_ms-stamped count". Cheap and conservative
   * (occasionally schedules a refresh slightly early; never skips a
   * stale one). */
  let count = 0;
  for (const c of all) {
    /* brainstorm_chunks rows have a created_at ISO field; treat
     * anything later than last_summary_ms as "new". */
    const ts = c.created_at ? Date.parse(c.created_at) : 0;
    if (ts > row.last_summary_ms) count++;
  }
  return count;
}

async function refreshRollingSummary(
  deps: GroomingDeps,
  row: BrainstormSessionRow,
  out: GroomingResult,
): Promise<string | null> {
  if (!deps.generator) {
    out.rolling_summary_written = false;
    return null;
  }
  try {
    const refreshed = deps.db.getBrainstorm(row.id) ?? row;
    const summary = await deps.generator(refreshed);
    if (summary && summary.trim().length > 0) {
      const trimmed = summary.trim();
      deps.db.updateBrainstorm(row.id, {
        last_summary: trimmed,
        last_summary_ms: (deps.now ?? Date.now)(),
      });
      out.rolling_summary_written = true;
      return trimmed;
    }
    out.rolling_summary_written = false;
    return null;
  } catch (err) {
    out.errors.push(`rolling_summary: ${(err as Error).message}`);
    out.rolling_summary_written = false;
    return null;
  }
}

function gatherRecentTurns(
  db: IndexDb,
  brainstormId: string,
  cap: number,
): HandoverPayload['recentTurns'] {
  const chunks = db.listBrainstormChunks(brainstormId, cap, { order: 'desc' });
  return chunks
    .slice()
    .reverse()
    .map((c) => ({
      role: (c.role === 'lex' || c.role === 'user' ? c.role : 'tool') as
        | 'user'
        | 'lex'
        | 'tool',
      text: c.text,
    }));
}

function writeHandoverIfWired(
  deps: GroomingDeps,
  row: BrainstormSessionRow,
  rollingSummary: string | null,
  out: GroomingResult,
): void {
  if (!deps.writeHandover) {
    out.handover_written = false;
    return;
  }
  try {
    const payload: HandoverPayload = {
      brainstormId: row.id,
      userLabel: row.user_label ?? null,
      derivedLabel: row.derived_label ?? null,
      mode: row.mode ?? 'conversation',
      generatedAt: nowIso(deps.now ?? Date.now),
      /* Phase 2 placeholder: active arcs / parked decisions / planted
       * markers stay empty until the dedicated extractors land. The
       * handover doc still ships with the rolling summary + recent
       * turns so it is useful immediately; the structured sections
       * become populated as the upstream detectors gain hooks. */
      activeArcs: [],
      parkedDecisions: [],
      plantedMarkers: [],
      rollingSummary,
      recentTurns: gatherRecentTurns(deps.db, row.id, RECENT_TURNS_FOR_HANDOVER),
    };
    const result = deps.writeHandover(payload);
    out.handover_written = true;
    out.handover_path = result.filePath;
  } catch (err) {
    out.errors.push(`handover: ${(err as Error).message}`);
    out.handover_written = false;
  }
}

async function finalizeDayCap(
  deps: GroomingDeps,
  row: BrainstormSessionRow,
  out: GroomingResult,
): Promise<void> {
  try {
    /* SM-27 (2026-07-18, operator): distill BEFORE flipping ended, no
     * exceptions. The old order flipped status='ended' first, so a
     * daemon death in the window before runFinalDistillation wrote
     * its pending-distill marker left an ended brainstorm with no
     * distillation and no recovery record - the next cold start read
     * stale context. runFinalDistillation (wired to
     * queueSessionEndPipeline in daemon.ts) writes the marker
     * synchronously and the terminal pipeline flips ended itself, so
     * running it first both guarantees the marker and does the
     * status flip; the explicit flip below is now just the belt for
     * the (prod-unreachable) unwired case. */
    if (deps.runFinalDistillation) {
      await deps.runFinalDistillation(row.id);
    } else {
      (deps.log ?? (() => undefined))(
        `[grooming] DAY-CAP WITHOUT DISTILLATION: runFinalDistillation not wired for brainstorm=${row.id.slice(0, 8)}; ending with stale context (should never happen in prod)`,
      );
    }
    deps.db.updateBrainstorm(row.id, {
      lifecycle_state: 'ended',
      status: 'ended',
      ended_ms: row.ended_ms ?? (deps.now ?? Date.now)(),
    });
    out.ended_at_day_cap = true;
  } catch (err) {
    out.errors.push(`day_cap_finalize: ${(err as Error).message}`);
    out.ended_at_day_cap = false;
  }
}

export async function runGroomingPass(
  kind: GroomingKind,
  brainstormId: string,
  deps: GroomingDeps,
): Promise<GroomingResult> {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const ranAt = new Date(now()).toISOString();
  const out: GroomingResult = {
    kind,
    brainstormId,
    ran_at: ranAt,
    rolling_summary_written: null,
    handover_written: null,
    handover_path: null,
    ended_at_day_cap: null,
    errors: [],
  };
  const row = deps.db.getBrainstorm(brainstormId);
  if (!row) {
    out.errors.push('row_missing');
    return out;
  }
  if (row.lifecycle_state === 'speaking' || row.lifecycle_state === 'ended') {
    out.errors.push(`skipped_lifecycle_${row.lifecycle_state}`);
    return out;
  }
  log(`[grooming] brainstorm=${brainstormId} kind=${kind} start`);

  /* Step 1 (light, mid, cold, day-cap): rolling summary refresh when
   * enough new turns landed since the last write. Light gate uses
   * the 10-turn floor; mid+ skip the floor because the elevated
   * cadence implies the operator wants fresh context regardless. */
  let summary: string | null = null;
  if (kind === 'light') {
    const newTurns = newTurnsSinceLastSummary(deps.db, row);
    if (newTurns >= MIN_NEW_TURNS_FOR_SUMMARY) {
      summary = await refreshRollingSummary(deps, row, out);
    } else {
      out.rolling_summary_written = false;
      log(
        `[grooming] brainstorm=${brainstormId} light pass: only ${newTurns} new turns, skipping summary`,
      );
    }
  } else {
    summary = await refreshRollingSummary(deps, row, out);
  }

  /* Step 2 (cold, day-cap): write the HANDOVER doc on disk. */
  if (kind === 'cold' || kind === 'day-cap') {
    writeHandoverIfWired(deps, row, summary, out);
  }

  /* Step 3 (day-cap only): flip status to ended + run the final
   * session-end distillation. The kind itself is the trigger; the
   * idle-watcher fires day-cap at the 6h threshold OR at the 06:00
   * local cron (which is a separate scheduler responsibility, not
   * decidePendingPass's job). */
  if (kind === 'day-cap') {
    await finalizeDayCap(deps, row, out);
  }

  /* Step 4 (all kinds): stamp the row so subsequent ticks observe
   * the cooldown. Wrapped so a setter failure does not break the
   * pass's caller observability. */
  try {
    deps.db.updateBrainstorm(brainstormId, {
      last_grooming_pass_at: ranAt,
      last_grooming_kind: kind,
    });
  } catch (err) {
    out.errors.push(`stamp_grooming: ${(err as Error).message}`);
  }
  log(
    `[grooming] brainstorm=${brainstormId} kind=${kind} done summary=${out.rolling_summary_written} handover=${out.handover_written} ended=${out.ended_at_day_cap} errors=${out.errors.length}`,
  );
  return out;
}
