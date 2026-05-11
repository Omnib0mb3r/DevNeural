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

/* Patch the brainstorm record once the underlying claude session
 * uuid is known (jsonl appears). Resolves by ptyId (set at spawn);
 * returns null if no record exists for that pty. */
export function bindBrainstormSessionId(
  ptyId: string,
  claudeSessionId: string,
): BrainstormSessionRow | null {
  const existing = db().getBrainstormByPty(ptyId);
  if (!existing) return null;
  return db().updateBrainstorm(existing.id, {
    claude_session_id: claudeSessionId,
  });
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
  return touched;
}
