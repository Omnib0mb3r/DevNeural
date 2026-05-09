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

export function listBrainstorms(opts: {
  status?: 'active' | 'ended';
  limit?: number;
} = {}): BrainstormSessionRow[] {
  return db().listBrainstorms(opts);
}
