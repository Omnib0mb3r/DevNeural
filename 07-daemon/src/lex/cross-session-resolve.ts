/**
 * Fix 15 — anchor-resolved dispatch for /lex/inject-cross-session.
 *
 * Treats target_session as a hint. If the uuid maps to a known
 * project anchor whose current_session_id has flipped since the caller
 * cached it, redirects the inject to the live uuid. If the owning
 * anchor is dormant, returns a structured dormant outcome so the
 * route layer can park the inject (smart-compact resume will replay
 * it when the anchor revives — see C3 of this fix stack).
 *
 * Exported as a pure function so unit tests can exercise the three
 * outcomes without spinning up Fastify.
 */

import type { IndexDb } from '../store/index-db.js';

export type ResolveAnchorOutcome =
  | {
      kind: 'pass';
      /* No anchor mapping — caller addressed a session with no known
       * project anchor (e.g. a VS Code terminal launched outside the
       * daemon). The route should fall through to the legacy inject
       * path with no rewrite. */
      dispatch_session: string;
      anchor_id?: undefined;
    }
  | {
      kind: 'live-direct';
      /* Anchor owns the requested uuid and it is still the live
       * current_session_id. Dispatch unchanged. */
      dispatch_session: string;
      anchor_id: string;
    }
  | {
      kind: 'redirect';
      /* Anchor exists, is live under a different uuid. Dispatch to
       * the live uuid; the route writes a 'redirected' audit row
       * stamping {old, new, anchor_id}. */
      dispatch_session: string;
      anchor_id: string;
      old_session: string;
    }
  | {
      kind: 'dormant';
      /* Anchor exists but has no live current_session_id. Caller
       * should receive 422 + reason='bound-anchor-dormant' and the
       * route writes a 'dispatched_dead_session' audit row so smart-
       * compact resume can replay this inject when the anchor revives. */
      anchor_id: string;
    };

export function resolveAnchorDispatch(
  db: Pick<IndexDb, 'findProjectSessionBySessionId'>,
  targetSession: string,
): ResolveAnchorOutcome {
  const anchor = db.findProjectSessionBySessionId(targetSession);
  if (!anchor) {
    return { kind: 'pass', dispatch_session: targetSession };
  }
  const live = anchor.current_session_id;
  const isDormant = anchor.status === 'dormant' || !live;
  if (isDormant) {
    return { kind: 'dormant', anchor_id: anchor.id };
  }
  if (live && live !== targetSession) {
    return {
      kind: 'redirect',
      dispatch_session: live,
      anchor_id: anchor.id,
      old_session: targetSession,
    };
  }
  return {
    kind: 'live-direct',
    dispatch_session: targetSession,
    anchor_id: anchor.id,
  };
}

/* SESSIONS-VIEW read-only (2026-07-18), defects 1 + 3: the terminal
 * MIRROR binds by a session uuid, but the Sessions page freezes that
 * uuid in the URL. After a /clear or restart the owning anchor's live
 * session moved on, so the frozen uuid's output ring is empty (producers
 * only ever fill the ring under the CURRENT live session id) and the
 * mirror is blank while the durable transcript still renders. Resolve
 * the requested uuid through the SAME anchor mapping Fix 15 uses so the
 * mirror binds to the anchor's live session ring - the fix the mirror
 * routes never got. Read-only (a pure DB lookup); returns the raw uuid
 * unchanged when there is no live redirect (no anchor, still-current, or
 * dormant with no live ring to bind). */
export function resolveMirrorSessionId(
  db: Pick<IndexDb, 'findProjectSessionBySessionId'>,
  rawSessionId: string,
): string {
  const outcome = resolveAnchorDispatch(db, rawSessionId);
  return outcome.kind === 'redirect' ? outcome.dispatch_session : rawSessionId;
}
