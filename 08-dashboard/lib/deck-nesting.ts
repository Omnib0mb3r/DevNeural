/**
 * Stream Deck worker-under-brainstorm nesting match (BUG-001).
 *
 * A brainstorm tile nests the worker it supervises. The match is on the
 * authoritative worker SESSION ID (project_session.current_session_id,
 * surfaced as tile.supervised_worker_session_id) against the session
 * groups — NOT on slug. The tile-side project_slug is a short name
 * ("DevNeural") while the session-side group slug is the mangled
 * ~/.claude/projects dir ("c--dev-Projects-DevNeural"); those two
 * formats never string-match, and case is unreliable on top of that.
 * The session id is the binding the rest of the code already resolves,
 * so it is the correct, stable key.
 */

export interface NestGroupLike {
  slug: string;
  sessions: { session_id: string }[];
}

export interface NestTileLike {
  supervised_worker_session_id: string | null;
}

/** The session group a brainstorm tile supervises: the group that
 * contains the tile's supervised worker session id. Undefined when the
 * tile has no resolved worker session, or no group contains it. */
export function supervisedGroupFor<G extends NestGroupLike>(
  tile: NestTileLike,
  groups: G[],
): G | undefined {
  const sid = tile.supervised_worker_session_id;
  if (!sid) return undefined;
  return groups.find((g) => g.sessions.some((s) => s.session_id === sid));
}

/** True when some tile supervises a session in this group — i.e. the
 * group is nested under a brainstorm, not an orphan worker. */
export function isGroupSupervised(
  group: NestGroupLike,
  tiles: NestTileLike[],
): boolean {
  return tiles.some(
    (t) =>
      t.supervised_worker_session_id != null &&
      group.sessions.some(
        (s) => s.session_id === t.supervised_worker_session_id,
      ),
  );
}
