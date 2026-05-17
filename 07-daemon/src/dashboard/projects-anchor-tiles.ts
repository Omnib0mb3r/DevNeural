/**
 * Stream Deck tile builder for live project anchors
 * (PROJECT-ANCHORS.md step 4 of 6).
 *
 * Mirrors lex/anchor-tiles for the project_session surface. One tile
 * per live anchor, deduplicated by anchor id so multiple VS Code
 * windows on the same cwd render as a single tile with a
 * bridge_connection_count badge. Phase comes from the tail of the
 * most recent project_transcript_ref jsonl using the same vocab as
 * /sessions.
 */
import { derivePhaseFromTail } from './sessions.js';
import { getPhase } from './session-phase.js';
import { getPending, type PendingPrompt } from './pending-prompt.js';
import { decodeBridgeMarker } from './bridge-presence.js';
import type {
  IndexDb,
  ProjectSessionRow,
  ProjectTranscriptRefRow,
} from '../store/index-db.js';

export interface ProjectAnchorTile {
  anchor_id: string;
  project_slug: string;
  title: string | null;
  cwd: string;
  status: 'live' | 'dormant';
  current_session_id: string | null;
  current_bridge_id: string | null;
  bridge_connection_count: number;
  current_pty_id: string | null;
  transcript_path: string | null;
  /** thinking | tool | permission | idle | unknown — same vocab as
   * /sessions. */
  phase: 'thinking' | 'tool' | 'permission' | 'idle' | 'unknown';
  pending_prompt: PendingPrompt | null;
  last_activity_ms: number;
  transcript_count: number;
  /** EVENT-DRIVEN-SUPERVISION.md: per-anchor toggle. The dashboard
   * ProjectsGrid mounts a three-state control bound to this column
   * via PATCH /projects/:id. */
  supervision_mode: 'polling' | 'event' | 'off';
}

function latestTranscriptRef(
  refs: ProjectTranscriptRefRow[],
): ProjectTranscriptRefRow | null {
  if (refs.length === 0) return null;
  /* Already sorted opened_ms ASC by listProjectTranscriptRefs; the
   * tail is the most recent. */
  return refs[refs.length - 1] ?? null;
}

function lastActivityMs(
  row: ProjectSessionRow,
  refs: ProjectTranscriptRefRow[],
): number {
  const fromRefs = refs.reduce<number>((acc, r) => {
    const t = r.closed_ms ?? r.opened_ms;
    return t > acc ? t : acc;
  }, 0);
  return fromRefs > 0 ? fromRefs : row.last_seen_ms;
}

export interface BuildTileOptions {
  /** Phase resolver. Defaults to session-phase getPhase. Tests can
   * inject a stub to avoid depending on the live session-phase Map. */
  phaseResolver?: (ccSessionId: string) => ProjectAnchorTile['phase'];
  /** Tail-phase resolver. Defaults to derivePhaseFromTail. Tests can
   * inject 'unknown' to skip the fs read. */
  tailPhaseResolver?: (
    transcriptPath: string,
  ) => ProjectAnchorTile['phase'];
  /** Pending-prompt resolver. Defaults to getPending. */
  pendingResolver?: (ccSessionId: string) => PendingPrompt | null;
}

export function buildProjectAnchorTile(
  db: IndexDb,
  row: ProjectSessionRow,
  opts: BuildTileOptions = {},
): ProjectAnchorTile {
  const refs = db.listProjectTranscriptRefs(row.id);
  const current = latestTranscriptRef(refs);
  const decoded = decodeBridgeMarker(row.current_bridge_id);

  const phaseResolver = opts.phaseResolver ?? getPhase;
  const tailResolver = opts.tailPhaseResolver ?? derivePhaseFromTail;
  const pendingResolver = opts.pendingResolver ?? getPending;

  let phase: ProjectAnchorTile['phase'] = 'unknown';
  let pending: PendingPrompt | null = null;
  if (current) {
    phase = phaseResolver(current.cc_session_id);
    const tail = tailResolver(current.jsonl_path);
    if (tail !== 'unknown') phase = tail;
    pending = pendingResolver(current.cc_session_id);
    if (pending) phase = 'permission';
  }

  return {
    anchor_id: row.id,
    project_slug: row.project_slug,
    title: row.title,
    cwd: row.cwd,
    status: row.status,
    current_session_id: row.current_session_id,
    current_bridge_id: decoded.primaryBridgeId,
    bridge_connection_count: decoded.count,
    current_pty_id: row.current_pty_id,
    transcript_path: current?.jsonl_path ?? null,
    phase,
    pending_prompt: pending,
    last_activity_ms: lastActivityMs(row, refs),
    transcript_count: refs.length,
    supervision_mode: (row.supervision_mode ?? db.getDefaultSupervisionMode()) as
      | 'polling'
      | 'event'
      | 'off',
  };
}

export function listProjectAnchorTiles(
  db: IndexDb,
  opts: BuildTileOptions = {},
): ProjectAnchorTile[] {
  const rows = db.listProjectSessions({ status: 'live', limit: 200 });
  const tiles = rows.map((row) => buildProjectAnchorTile(db, row, opts));
  tiles.sort((a, b) => b.last_activity_ms - a.last_activity_ms);
  return tiles;
}
