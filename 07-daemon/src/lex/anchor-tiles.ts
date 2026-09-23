/**
 * Stream Deck tile builder for live Lex anchors
 * (PLAN-lex-session-rewrite.md, step 5).
 *
 * Each live anchor surfaces as a read-only tile alongside the live
 * Claude Code project tiles. Phase is derived from the tail of the
 * anchor's most recent transcript jsonl using the same vocabulary
 * as /sessions (thinking/tool/permission/idle/unknown). The
 * 'dormant' state is included for completeness but never returned
 * here; callers filter by status='live'.
 *
 * No tap action. Tiles are visibility only per the plan; the click
 * action (spawn-or-bind to bring an anchor live) lives on the
 * /lex Past Sessions panel, not on the deck.
 *
 * Context gauge (2026-09-22, Task 10): every tile also carries the
 * supervised worker's and Lex's own context usage as whole percents
 * plus the smart-clear trip marks (threshold + ceiling), so the
 * dashboard draws one gauge shape on every session surface.
 */
import { listLexSessions, listTranscriptRefs } from './lex-session-store.js';
import {
  contextPct,
  deriveContextFromTail,
  derivePhaseFromTail,
} from '../dashboard/sessions.js';
import { getPhase } from '../dashboard/session-phase.js';
import { getPending, type PendingPrompt } from '../dashboard/pending-prompt.js';
import { getLivePtyIds } from '../dashboard/pty-host.js';
import { getStore } from './brainstorm-store.js';
import { transcriptPathFor } from './spawn-lex-session.js';
import {
  DEFAULT_CEILING_PCT,
  DEFAULT_THRESHOLD_PCT,
  smartClearConfig,
} from './smart-clear.js';

export interface AnchorTile {
  anchor_id: string;
  title: string | null;
  derived_title: string | null;
  status: 'live' | 'dormant';
  current_pty_id: string | null;
  current_cc_session_id: string | null;
  transcript_path: string | null;
  /** thinking | tool | permission | idle | unknown, the same vocab as
   * /sessions. */
  phase: 'thinking' | 'tool' | 'permission' | 'idle' | 'unknown';
  pending_prompt: PendingPrompt | null;
  last_activity_ms: number;
  transcript_count: number;
  /** project_slug of the worker anchor this brainstorm supervises
   * (lex_session.supervises_project_anchor_id resolved), or null when
   * unbound. Retained for display/diagnostics; the Stream Deck no
   * longer nests off this (see supervised_worker_session_id). */
  supervised_project_slug: string | null;
  /** Live worker SESSION ID of the anchor this brainstorm supervises
   * (project_session.current_session_id resolved), or null when unbound
   * / not yet resolved. The Stream Deck nests the worker under the
   * brainstorm by matching THIS against the session tiles, because the
   * tile-side project_slug (a short name) and the session-side group
   * slug (the mangled ~/.claude/projects dir name) are different
   * formats that never string-match. The session id is the
   * authoritative binding the rest of the code already resolves. */
  supervised_worker_session_id: string | null;
  /** Supervised worker's context usage, whole percent of its window,
   * derived from the worker's own jsonl tail. Null when unbound, when
   * the worker has no live session yet, or before its first usage
   * record. Scope fail-closed: only THIS anchor's supervised worker. */
  worker_ctx_pct: number | null;
  /** Lex's own context usage, whole percent, from the anchor's
   * current transcript. Null before the first usage record. */
  lex_ctx_pct: number | null;
  /** Smart-clear trip marks (runtime_config, smartClearConfig): the
   * early wind-down threshold and the force-stop ceiling. The gauge
   * draws both as vertical marks. */
  ctx_threshold_pct: number;
  ctx_ceiling_pct: number;
}

/** Resolve the supervised worker's project_slug for one lex session
 * row. Pure over the injected resolver so it pins without a store. */
export function supervisedSlugFor(
  row: { supervises_project_anchor_id?: string | null },
  resolveProjectSlug?: (anchorId: string) => string | null,
): string | null {
  if (!row.supervises_project_anchor_id || !resolveProjectSlug) return null;
  try {
    return resolveProjectSlug(row.supervises_project_anchor_id) ?? null;
  } catch {
    return null;
  }
}

/** Resolve the supervised worker's live SESSION ID for one lex session
 * row (project_session.current_session_id). Pure over the injected
 * resolver so it pins without a store. Null when unbound, the resolver
 * is missing, the anchor is unknown, or no live worker session has been
 * resolved onto the anchor yet (fresh worker before backfill). */
export function supervisedWorkerSessionIdFor(
  row: { supervises_project_anchor_id?: string | null },
  resolveWorkerSessionId?: (anchorId: string) => string | null,
): string | null {
  if (!row.supervises_project_anchor_id || !resolveWorkerSessionId) return null;
  try {
    return resolveWorkerSessionId(row.supervises_project_anchor_id) ?? null;
  } catch {
    return null;
  }
}

/** Tail-derive seam: deriveContextFromTail in prod, injectable for
 * pins that never touch the filesystem. */
export type ContextDeriver = (
  transcriptPath: string,
) => { tokens: number; max: number } | null;

/** Supervised worker's context usage (whole percent) for one lex
 * session row. The worker jsonl lives exactly where Claude Code writes
 * it: transcriptPathFor({ cwd: project_session.cwd, ccSessionId:
 * project_session.current_session_id }). Null when unbound, when either
 * half of the binding cannot be resolved, before the first usage
 * record, or when anything throws. Never a fake 0. */
export function workerCtxPctFor(
  row: { supervises_project_anchor_id?: string | null },
  resolveWorkerSessionId?: (anchorId: string) => string | null,
  resolveWorkerCwd?: (anchorId: string) => string | null,
  derive: ContextDeriver = deriveContextFromTail,
): number | null {
  const ccSessionId = supervisedWorkerSessionIdFor(row, resolveWorkerSessionId);
  if (!ccSessionId || !resolveWorkerCwd) return null;
  try {
    const cwd = resolveWorkerCwd(row.supervises_project_anchor_id!);
    if (!cwd) return null;
    return contextPct(derive(transcriptPathFor({ cwd, ccSessionId })));
  } catch {
    return null;
  }
}

/** Lex's own context usage (whole percent) from the anchor's current
 * transcript. Null without a transcript, before the first usage
 * record, or when the derive throws. */
export function lexCtxPctFor(
  transcriptPath: string | null | undefined,
  derive: ContextDeriver = deriveContextFromTail,
): number | null {
  if (!transcriptPath) return null;
  try {
    return contextPct(derive(transcriptPath));
  } catch {
    return null;
  }
}

export interface AnchorTileOptions {
  /** cwd of the supervised worker's project anchor
   * (project_session.cwd). Defaults to the store lookup. */
  resolveWorkerCwd?: (anchorId: string) => string | null;
  /** Live PTY ids for the liveness cross-check. Defaults to the
   * pty-host map; injectable so a pin can run without a spawned PTY. */
  livePtyIds?: ReadonlySet<string>;
  /** Tail-derive seam (see ContextDeriver). */
  deriveContext?: ContextDeriver;
  /** Trip marks; default smartClearConfig(db). */
  ctxConfig?: { thresholdPct: number; ceilingPct: number };
}

function storeWorkerCwd(anchorId: string): string | null {
  try {
    return getStore().db.getProjectSession(anchorId)?.cwd ?? null;
  } catch {
    return null;
  }
}

/* Read once per tile sweep: the two marks are dashboard-wide, so every
 * tile in a response carries the same pair. Falls back to the
 * built-in defaults when the store is unavailable rather than failing
 * the whole tile feed over a config read. */
function storeCtxConfig(): { thresholdPct: number; ceilingPct: number } {
  try {
    const cfg = smartClearConfig(getStore().db);
    return { thresholdPct: cfg.thresholdPct, ceilingPct: cfg.ceilingPct };
  } catch {
    return { thresholdPct: DEFAULT_THRESHOLD_PCT, ceilingPct: DEFAULT_CEILING_PCT };
  }
}

export function listAnchorTiles(
  resolveProjectSlug?: (anchorId: string) => string | null,
  resolveWorkerSessionId?: (anchorId: string) => string | null,
  opts: AnchorTileOptions = {},
): AnchorTile[] {
  const live = listLexSessions({ status: 'live', limit: 200 });
  const liveSet = opts.livePtyIds ?? getLivePtyIds();
  const resolveWorkerCwd = opts.resolveWorkerCwd ?? storeWorkerCwd;
  const derive = opts.deriveContext ?? deriveContextFromTail;
  const ctxConfig = opts.ctxConfig ?? storeCtxConfig();
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
      // idle_prompt (CC's "still working?" idle rhythm) is NOT a user
      // action item - the bell already routes it to 'signal' (off the
      // bell); the tile must match, or a plain idle session paints red
      // "needs input". Only a real permission/elicitation prompt turns
      // the tile to 'permission'; an idle_prompt leaves it idle.
      if (pending && pending.kind !== 'idle_prompt') phase = 'permission';
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
      supervised_project_slug: supervisedSlugFor(row, resolveProjectSlug),
      supervised_worker_session_id: supervisedWorkerSessionIdFor(
        row,
        resolveWorkerSessionId,
      ),
      worker_ctx_pct: workerCtxPctFor(
        row,
        resolveWorkerSessionId,
        resolveWorkerCwd,
        derive,
      ),
      lex_ctx_pct: lexCtxPctFor(current?.transcript_path ?? null, derive),
      ctx_threshold_pct: ctxConfig.thresholdPct,
      ctx_ceiling_pct: ctxConfig.ceilingPct,
    });
  }
  tiles.sort((a, b) => b.last_activity_ms - a.last_activity_ms);
  return tiles;
}
