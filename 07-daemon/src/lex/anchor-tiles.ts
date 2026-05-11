/**
 * Stream Deck tile builder for live Lex anchors
 * (PLAN-lex-session-rewrite.md, step 5).
 *
 * Each live anchor surfaces as a read-only tile alongside the live
 * Claude Code project tiles. Phase is derived from the tail of the
 * anchor's most recent transcript jsonl using the same vocabulary
 * as /sessions (thinking/tool/permission/idle/unknown). The
 * 'dormant' state is included for completeness but never returned
 * here — callers filter by status='live'.
 *
 * No tap action. Tiles are visibility only per the plan; the click
 * action (spawn-or-bind to bring an anchor live) lives on the
 * /lex Past Sessions panel, not on the deck.
 */
import { listLexSessions, listTranscriptRefs } from './lex-session-store.js';
import {
  derivePhaseFromTail,
} from '../dashboard/sessions.js';
import { getPhase } from '../dashboard/session-phase.js';
import { getPending, type PendingPrompt } from '../dashboard/pending-prompt.js';
import { getLivePtyIds } from '../dashboard/pty-host.js';

export interface AnchorTile {
  anchor_id: string;
  title: string | null;
  derived_title: string | null;
  status: 'live' | 'dormant';
  current_pty_id: string | null;
  current_cc_session_id: string | null;
  transcript_path: string | null;
  /** thinking | tool | permission | idle | unknown — same vocab as
   * /sessions. */
  phase: 'thinking' | 'tool' | 'permission' | 'idle' | 'unknown';
  pending_prompt: PendingPrompt | null;
  last_activity_ms: number;
  transcript_count: number;
}

export function listAnchorTiles(): AnchorTile[] {
  const live = listLexSessions({ status: 'live', limit: 200 });
  const liveSet = getLivePtyIds();
  const tiles: AnchorTile[] = [];
  for (const row of live) {
    /* Cross-check liveness against the actual live PTY map. The
     * lex_session.status column can drift to a stale 'live' if the
     * daemon was killed mid-session without firing onExit; without
     * this guard the deck would surface a ghost tile until the
     * continuous reaper next runs (codex finding #5). */
    if (!row.current_pty_id || !liveSet.has(row.current_pty_id)) continue;
    const refs = listTranscriptRefs(row.id);
    const current = refs[refs.length - 1] ?? null;
    let phase: AnchorTile['phase'] = 'unknown';
    let pending: PendingPrompt | null = null;
    if (current) {
      phase = getPhase(current.cc_session_id);
      const tailPhase = derivePhaseFromTail(current.transcript_path);
      if (tailPhase !== 'unknown') phase = tailPhase;
      pending = getPending(current.cc_session_id);
      if (pending) phase = 'permission';
    }
    const lastActivity =
      refs.reduce<number>((acc, r) => {
        const t = r.ended_ms ?? r.started_ms;
        return t > acc ? t : acc;
      }, 0) || row.created_ms;
    tiles.push({
      anchor_id: row.id,
      title: row.title,
      derived_title: row.derived_title,
      status: row.status,
      current_pty_id: row.current_pty_id,
      current_cc_session_id: current?.cc_session_id ?? null,
      transcript_path: current?.transcript_path ?? null,
      phase,
      pending_prompt: pending,
      last_activity_ms: lastActivity,
      transcript_count: refs.length,
    });
  }
  tiles.sort((a, b) => b.last_activity_ms - a.last_activity_ms);
  return tiles;
}
