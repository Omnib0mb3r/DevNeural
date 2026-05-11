/**
 * Brainstorm session record store (Slice A).
 *
 * First-class metadata for every Lex PTY spawn. Each record holds
 * lifecycle (started/ended), labels (user-supplied + Lex-derived),
 * mode (conversation/notes/push-to-talk), turn count, topic tags,
 * and an artifacts manifest pointing at research notes, wiki drafts,
 * reminders, and spawned projects produced during the session.
 *
 * Singleton accessor: the daemon's Store owns the IndexDb instance;
 * we set it once on daemon boot via setStore(). Helpers below are
 * thin wrappers so callers don't have to thread the store reference
 * through every layer (PTY spawn, voice WS, REST routes).
 */
import { randomUUID } from 'node:crypto';
import type { Store } from '../store/index.js';
import type { BrainstormSessionRow } from '../store/index-db.js';

let _store: Store | null = null;

export function setStore(s: Store): void {
  _store = s;
}

/* Resolver used by session-end-pipeline and other lex/* modules that
 * need the full store but aren't on a code path the daemon threads
 * the store reference through (voice WS handler, PTY exit handler,
 * artifact-parser). The daemon calls setStore() once at boot so this
 * is always populated by the time these handlers fire. */
export function getStore(): Store {
  if (!_store) {
    throw new Error('brainstorm-store: Store not initialised yet');
  }
  return _store;
}

function db() {
  if (!_store) {
    throw new Error('brainstorm-store: Store not initialised yet');
  }
  return _store.db;
}

interface ArtifactRef {
  id: string;
  title?: string;
  added_ms?: number;
  /* Wave 2 carry-over #1: claude-code assistant message uuid that
   * spawned this artifact. Used as turn_id by LexThumbs so per-turn
   * thumbs aggregate across every artifact emitted in the same turn. */
  turn_id?: string;
}

interface Artifacts {
  research_notes: ArtifactRef[];
  wiki_drafts: ArtifactRef[];
  reminders: ArtifactRef[];
  spawned_projects: ArtifactRef[];
}

function emptyArtifacts(): Artifacts {
  return {
    research_notes: [],
    wiki_drafts: [],
    reminders: [],
    spawned_projects: [],
  };
}

function parseArtifacts(json: string): Artifacts {
  try {
    const parsed = JSON.parse(json) as Partial<Artifacts>;
    return {
      research_notes: parsed.research_notes ?? [],
      wiki_drafts: parsed.wiki_drafts ?? [],
      reminders: parsed.reminders ?? [],
      spawned_projects: parsed.spawned_projects ?? [],
    };
  } catch {
    return emptyArtifacts();
  }
}

/* Cwd convention: anything under <dataRoot>/brainstorm/ is treated as
 * a Lex brainstorm spawn. Leaves room for project-rooted Lex spawns
 * later (different cwd) without auto-registering them. */
export function isBrainstormCwd(cwd: string): boolean {
  return /[\\/]brainstorm(\/|\\|$)/i.test(cwd.replace(/\\/g, '/'));
}

export function registerBrainstorm(opts: {
  ptyId: string;
  cwd: string;
  startedMs: number;
  mode?: string;
  userLabel?: string | null;
}): BrainstormSessionRow {
  const id = randomUUID();
  const row: BrainstormSessionRow = {
    id,
    claude_session_id: null,
    pty_id: opts.ptyId,
    cwd: opts.cwd.replace(/\\/g, '/'),
    user_label: opts.userLabel ?? null,
    derived_label: null,
    mode: opts.mode ?? 'conversation',
    status: 'active',
    started_ms: opts.startedMs,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: JSON.stringify(emptyArtifacts()),
    last_summary: null,
    last_summary_ms: null,
  };
  db().insertBrainstorm(row);
  return row;
}

/* Pre-bind a row to a freshly-spawned PTY before claude has written
 * its first jsonl. Used by the switch-to flow so the dashboard
 * stops showing the previous (now-dead) PTY id immediately. The
 * subsequent bindBrainstormSessionId call (when jsonl appears) will
 * also stamp the claude_session_id. */
export function rebindBrainstormToPty(
  brainstormId: string,
  ptyId: string,
): BrainstormSessionRow | null {
  return db().updateBrainstorm(brainstormId, {
    pty_id: ptyId,
    status: 'active',
    ended_ms: null,
  });
}

/* Update the brainstorm row identified by brainstormId with the
 * claude_session_id that just appeared in the PTY's jsonl. This is
 * called from tryDiscoverSession in pty-host once claude writes its
 * first turn. The pty_id is also re-stamped so a row resumed onto a
 * fresh PTY ends up pointing at the live process. status is bumped
 * back to 'active' and ended_ms cleared for the resume case.
 *
 * The brainstorm row is the canonical session identity. The
 * claude_session_id is a mutable pointer at the underlying jsonl —
 * if claude --resume is rejected by the CLI and a fresh session id
 * is minted, this call simply repoints the row at the new id; the
 * row itself does not split. */
export function bindBrainstormSessionId(
  brainstormId: string,
  ptyId: string,
  claudeSessionId: string,
): BrainstormSessionRow | null {
  return db().updateBrainstorm(brainstormId, {
    pty_id: ptyId,
    claude_session_id: claudeSessionId,
    status: 'active',
    ended_ms: null,
  });
}

/* Sweep active rows whose pty_id is not in the live PTY map. Called
 * on a periodic interval (in addition to once at boot) so a PTY that
 * died without firing its onExit handler — daemon SIGKILL, OS
 * teardown, anything that bypasses graceful exit — gets reaped
 * within the interval rather than sitting as a phantom active row
 * with no live process behind it.
 *
 * Sweeps BOTH the legacy brainstorm_sessions table and the new
 * lex_session table so the post-rip-out world stays honest about
 * anchor liveness even when the daemon crashed before onExit fired. */
export function reapOrphansAgainstLivePtys(
  livePtyIds: ReadonlySet<string>,
  reason: string,
): number {
  const rows = db().listBrainstorms({ status: 'active', limit: 10_000 });
  const now = Date.now();
  let touched = 0;
  for (const row of rows) {
    if (row.pty_id && livePtyIds.has(row.pty_id)) continue;
    db().updateBrainstorm(row.id, {
      status: 'ended',
      ended_ms: now,
      last_summary: reason,
      last_summary_ms: now,
    });
    touched += 1;
  }
  /* lex_session sweep mirror. */
  const liveAnchors = db().listLexSessions({ status: 'live', limit: 10_000 });
  for (const row of liveAnchors) {
    if (row.current_pty_id && livePtyIds.has(row.current_pty_id)) continue;
    db().updateLexSession(row.id, {
      status: 'dormant',
      current_pty_id: null,
    });
    touched += 1;
  }
  return touched;
}

export function setLabel(
  id: string,
  patch: { user_label?: string | null; derived_label?: string | null },
): BrainstormSessionRow | null {
  return db().updateBrainstorm(id, patch);
}

export function setMode(id: string, mode: string): BrainstormSessionRow | null {
  return db().updateBrainstorm(id, { mode });
}

export function endBrainstorm(
  id: string,
  summary?: string,
): BrainstormSessionRow | null {
  const now = Date.now();
  return db().updateBrainstorm(id, {
    status: 'ended',
    ended_ms: now,
    last_summary: summary ?? null,
    last_summary_ms: summary ? now : null,
  });
}

export function appendArtifact(
  id: string,
  category: keyof Artifacts,
  ref: ArtifactRef,
): BrainstormSessionRow | null {
  const existing = db().getBrainstorm(id);
  if (!existing) return null;
  const artifacts = parseArtifacts(existing.artifacts_json);
  const stamped: ArtifactRef = { ...ref, added_ms: ref.added_ms ?? Date.now() };
  artifacts[category] = [...artifacts[category], stamped];
  return db().updateBrainstorm(id, {
    artifacts_json: JSON.stringify(artifacts),
  });
}

export function getBrainstorm(id: string): BrainstormSessionRow | null {
  return db().getBrainstorm(id);
}

export function getBrainstormByClaudeSessionId(
  claudeSessionId: string,
): BrainstormSessionRow | null {
  return db().getBrainstormByClaudeSession(claudeSessionId);
}

export function getBrainstormByPty(
  ptyId: string,
): BrainstormSessionRow | null {
  return db().getBrainstormByPty(ptyId);
}

export function listBrainstorms(opts: {
  status?: 'active' | 'ended';
  limit?: number;
} = {}): BrainstormSessionRow[] {
  return db().listBrainstorms(opts);
}

/* Boot reaper. PTY exit handlers in pty-host close active rows, but a
 * daemon crash (SIGKILL, SqliteError fatal, etc.) skips them, leaving
 * rows stuck at status='active'. Call this once after the store opens
 * so the dashboard never starts with orphaned active sessions.
 *
 * Rows with zero substance (no chunks, no audio, no distilled summary)
 * are deleted outright rather than marked ended. They are auto-spawn
 * shells from the previous boot that the user never actually used;
 * keeping them clutters the Past Sessions list and buries real
 * sessions past the page limit. Substantive rows are still marked
 * ended in place so their history is preserved.
 *
 * Also sweeps long-tail cruft: ENDED rows with null claude_session_id
 * AND zero substance. Those are pre-bind orphans from the legacy
 * "register at spawn" path that bind-on-jsonl made obsolete. They
 * have no transcript to load, so they can't be resumed anyway —
 * deleting them collapses the past-sessions list to real
 * conversations only.
 * Bug: 2026-05-11-past-sessions-orphan-pollution. */
export function reapAllActive(reason: string): number {
  const rows = db().listBrainstorms({ status: 'active', limit: 10_000 });
  const now = Date.now();
  let touched = 0;
  for (const row of rows) {
    const chunks = db().countBrainstormChunks(row.id);
    const hasAudio = Boolean(row.audio_path);
    const hasDistilled = Boolean(row.distilled_at);
    if (chunks === 0 && !hasAudio && !hasDistilled) {
      db().deleteBrainstorm(row.id);
    } else {
      db().updateBrainstorm(row.id, {
        status: 'ended',
        ended_ms: now,
        last_summary: reason,
        last_summary_ms: now,
      });
    }
    touched += 1;
  }
  /* Long-tail cruft sweep: ended rows that never bound a claude
   * session (PTY died before jsonl) and have no substance. They
   * cannot be resumed and just bury real sessions in the UI. */
  const ended = db().listBrainstorms({ status: 'ended', limit: 10_000 });
  for (const row of ended) {
    if (row.claude_session_id) continue;
    const chunks = db().countBrainstormChunks(row.id);
    const hasAudio = Boolean(row.audio_path);
    const hasDistilled = Boolean(row.distilled_at);
    if (chunks === 0 && !hasAudio && !hasDistilled) {
      db().deleteBrainstorm(row.id);
      touched += 1;
    }
  }
  return touched;
}
