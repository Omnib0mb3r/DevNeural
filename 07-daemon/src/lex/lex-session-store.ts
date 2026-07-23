/**
 * Lex session store (PLAN-lex-session-rewrite.md, step 2 scaffolding).
 *
 * Thin helpers over IndexDb's lex_session and lex_transcript_ref CRUD
 * methods, mirroring the pattern in brainstorm-store.ts. Other modules
 * (spawn helper, system prompt builder, route handlers) call these so
 * they don't have to thread the Store reference through every layer.
 *
 * The Store reference is the same one brainstorm-store sets via
 * setStore(); we just pull it back out here. Importing brainstorm-store
 * keeps the boot wiring in one place — daemon.ts only calls setStore
 * once.
 */
import { randomUUID } from 'node:crypto';
import { getStore } from './brainstorm-store.js';
import type {
  LexSessionRow,
  LexTranscriptRefRow,
} from '../store/index-db.js';

function db() {
  return getStore().db;
}

export function createLexSession(opts: {
  cwd: string;
  title?: string | null;
  derivedTitle?: string | null;
  status?: 'live' | 'dormant';
  currentPtyId?: string | null;
  createdMs?: number;
}): LexSessionRow {
  const row: LexSessionRow = {
    id: randomUUID(),
    created_ms: opts.createdMs ?? Date.now(),
    title: opts.title ?? null,
    derived_title: opts.derivedTitle ?? null,
    status: opts.status ?? 'dormant',
    current_pty_id: opts.currentPtyId ?? null,
    cwd: opts.cwd.replace(/\\/g, '/'),
  };
  db().insertLexSession(row);
  return row;
}

export function getLexSession(id: string): LexSessionRow | null {
  return db().getLexSession(id);
}

export function listLexSessions(opts: {
  status?: 'live' | 'dormant';
  limit?: number;
} = {}): LexSessionRow[] {
  return db().listLexSessions(opts);
}

export function setLexSessionTitle(
  id: string,
  patch: { title?: string | null; derivedTitle?: string | null },
): LexSessionRow | null {
  return db().updateLexSession(id, {
    title: patch.title,
    derived_title: patch.derivedTitle,
  });
}

export function setLexSessionStatus(
  id: string,
  patch: { status: 'live' | 'dormant'; currentPtyId?: string | null },
): LexSessionRow | null {
  return db().updateLexSession(id, {
    status: patch.status,
    current_pty_id:
      patch.currentPtyId === undefined ? null : patch.currentPtyId,
  });
}

export function deleteLexSession(id: string): void {
  db().deleteLexSession(id);
}

/* Reversible hide/unhide for the Past Sessions list (migration 053).
 * archived=true drops the row out of GET /lex/anchors without touching
 * the anchor, its transcript refs, or the paired brainstorm row.
 * archived=false restores it. */
export function setLexSessionArchived(
  id: string,
  archived: boolean,
): LexSessionRow | null {
  return db().updateLexSession(id, { archived: archived ? 1 : 0 });
}

export function appendTranscriptRef(opts: {
  lexSessionId: string;
  ccSessionId: string;
  transcriptPath: string;
  startedMs?: number;
}): LexTranscriptRefRow {
  /* ordering = number of existing refs for this anchor. Refs are
   * inserted strictly in spawn order, so a simple count gives us the
   * correct 0-based slot without a SELECT MAX(). */
  const ordering = db().countLexTranscriptRefs(opts.lexSessionId);
  return db().insertLexTranscriptRef({
    lex_session_id: opts.lexSessionId,
    cc_session_id: opts.ccSessionId,
    transcript_path: opts.transcriptPath,
    started_ms: opts.startedMs ?? Date.now(),
    ended_ms: null,
    ordering,
  });
}

export function closeTranscriptRef(
  ccSessionId: string,
  endedMs?: number,
): void {
  const ref = db().getLexTranscriptRefByCc(ccSessionId);
  if (!ref) return;
  db().updateLexTranscriptRef(ref.id, { ended_ms: endedMs ?? Date.now() });
}

export function listTranscriptRefs(
  lexSessionId: string,
): LexTranscriptRefRow[] {
  return db().listLexTranscriptRefs(lexSessionId);
}

export function getTranscriptRefByCc(
  ccSessionId: string,
): LexTranscriptRefRow | null {
  return db().getLexTranscriptRefByCc(ccSessionId);
}
