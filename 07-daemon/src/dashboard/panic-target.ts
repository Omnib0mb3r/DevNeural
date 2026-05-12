/**
 * Panic single-target resolver (PANIC-BUTTON.md step 2 of 7).
 *
 * Picks the project anchor the global panic button should interrupt.
 * Resolution happens at click time (not at render) so the inputs are
 * the latest project_session rows and the live session-phase map.
 *
 * Rules in order:
 *   1. Exactly one live anchor          -> that anchor.
 *   2. Multiple live, phase in {thinking, tool} -> that one. Ties
 *      between busy anchors fall through to rule 3.
 *   3. Most recent last_seen_ms wins among the candidates from rule 2,
 *      or among all live anchors when no busy phase exists.
 *   4. No live anchor                   -> null (button disabled).
 */
import type { IndexDb, ProjectSessionRow } from '../store/index-db.js';
import { getPhase } from './session-phase.js';

export type PhaseLabel =
  | 'thinking'
  | 'tool'
  | 'permission'
  | 'idle'
  | 'unknown';

export interface ResolveOptions {
  /** Override the phase resolver. Tests inject a deterministic map;
   * production reads session-phase getPhase. */
  phaseResolver?: (ccSessionId: string) => PhaseLabel;
}

export type ResolveReason =
  | 'sole-live'
  | 'busy-phase'
  | 'most-recent'
  | 'no-target';

export interface ResolveResult {
  target: ProjectSessionRow | null;
  reason: ResolveReason;
}

const BUSY_PHASES = new Set<PhaseLabel>(['thinking', 'tool']);

function mostRecent(rows: ProjectSessionRow[]): ProjectSessionRow {
  return rows.reduce(
    (acc, row) => (row.last_seen_ms > acc.last_seen_ms ? row : acc),
    rows[0]!,
  );
}

export function resolvePanicTarget(
  db: IndexDb,
  opts: ResolveOptions = {},
): ResolveResult {
  const phaseOf = opts.phaseResolver ?? ((cc: string) => getPhase(cc));
  const live = db.listProjectSessions({ status: 'live', limit: 1000 });
  if (live.length === 0) return { target: null, reason: 'no-target' };
  if (live.length === 1) return { target: live[0]!, reason: 'sole-live' };

  const busy = live.filter((row) => {
    if (!row.current_session_id) return false;
    return BUSY_PHASES.has(phaseOf(row.current_session_id));
  });
  if (busy.length === 1) return { target: busy[0]!, reason: 'busy-phase' };
  if (busy.length > 1) {
    return { target: mostRecent(busy), reason: 'most-recent' };
  }
  return { target: mostRecent(live), reason: 'most-recent' };
}
