/**
 * Lex backlog store (autonomous supervisor phase 2).
 *
 * Thin wrapper over IndexDb's lex_backlog_items table. The atomic
 * claim primitive is the load-bearing piece: file-CAS on Windows
 * across Lex + daemon was racy and last-writer-wins ate concurrent
 * edits, so the canonical store moved into sqlite. claimBacklogItem
 * relies on the sqlite UPDATE ... WHERE clause to act as a CAS:
 * only one of two concurrent attempts flips status to 'in-flight';
 * the loser observes ok:false and reports the reason.
 *
 * The store is held module-local (mirrors brainstorm-store) so
 * callers do not have to thread an IndexDb reference through every
 * route handler. Tests pass an in-memory IndexDb via setStore.
 */
import type { BacklogItemInsert, BacklogItemRow, IndexDb } from '../store/index-db.js';
import { randomUUID } from 'node:crypto';

interface StoreSlot {
  db: IndexDb | null;
}
const slot: StoreSlot = { db: null };

export function setStore(s: { db: IndexDb }): void {
  slot.db = s.db;
}

function db(): IndexDb {
  if (!slot.db) {
    throw new Error('backlog-store: setStore() not called');
  }
  return slot.db;
}

export interface BacklogClaimResult {
  ok: boolean;
  /** Populated when ok=true. */
  row?: BacklogItemRow;
  /**
   * 'already-claimed' when the row was in-flight or owned by
   * another claimant. 'not-found' when the id does not exist.
   * 'wrong-status' when the row is done / parked. Mapped to a
   * stable string set so the dashboard panel can render a typed
   * reason instead of a raw error message.
   */
  reason?:
    | 'already-claimed'
    | 'not-found'
    | 'wrong-status'
    | 'no-claim-fields';
}

export interface BacklogDoneResult {
  ok: boolean;
  row?: BacklogItemRow;
  reason?: 'not-found' | 'not-in-flight' | 'not-owner';
}

export interface BacklogReleaseResult {
  ok: boolean;
  row?: BacklogItemRow;
  reason?: 'not-found' | 'not-in-flight' | 'not-owner';
}

export function listBacklog(opts: {
  status?: BacklogItemRow['status'];
  limit?: number;
} = {}): BacklogItemRow[] {
  return db().listBacklogItems(opts);
}

export function getBacklog(id: string): BacklogItemRow | null {
  return db().getBacklogItem(id);
}

export interface AddBacklogInput {
  id?: string;
  title: string;
  priority?: string;
  notes?: string | null;
  status?: BacklogItemRow['status'];
  added_at?: string;
}

export function addBacklogItem(input: AddBacklogInput): BacklogItemRow {
  const id = input.id ?? randomUUID();
  const row: BacklogItemInsert = {
    id,
    title: input.title,
    status: input.status ?? 'queued',
    priority: input.priority ?? 'polish',
    added_at: input.added_at ?? new Date().toISOString(),
    notes: input.notes ?? null,
  };
  db().insertBacklogItem(row);
  const out = db().getBacklogItem(id);
  if (!out) {
    /* should be unreachable; sqlite write failure throws upstream */
    throw new Error(`addBacklogItem: row vanished after insert (${id})`);
  }
  return out;
}

export interface ClaimBacklogInput {
  id: string;
  claimed_by: string;
  claimed_turn_uuid?: string | null;
  anchor_id?: string | null;
}

export function claimBacklogItem(
  input: ClaimBacklogInput,
): BacklogClaimResult {
  if (!input.id || !input.claimed_by) {
    return { ok: false, reason: 'no-claim-fields' };
  }
  const existing = db().getBacklogItem(input.id);
  if (!existing) return { ok: false, reason: 'not-found' };
  if (existing.status === 'in-flight') {
    return { ok: false, reason: 'already-claimed', row: existing };
  }
  if (existing.status === 'done' || existing.status === 'parked') {
    return { ok: false, reason: 'wrong-status', row: existing };
  }
  const changed = db().claimBacklogItem({
    id: input.id,
    claimed_by: input.claimed_by,
    claimed_at: new Date().toISOString(),
    claimed_turn_uuid: input.claimed_turn_uuid ?? null,
    anchor_id: input.anchor_id ?? null,
    injected_at: new Date().toISOString(),
  });
  if (changed === 0) {
    /* Lost the race to a concurrent caller; the row is now
     * in-flight under someone else. Re-read so the response
     * carries the winning claimant. */
    const after = db().getBacklogItem(input.id);
    return { ok: false, reason: 'already-claimed', row: after ?? undefined };
  }
  const row = db().getBacklogItem(input.id);
  return { ok: true, row: row ?? undefined };
}

export interface ReleaseBacklogInput {
  id: string;
  claimed_by: string;
  /** queued = put back on the queue; parked = pull off the active
   * pipeline without retiring (manual intervention pending). */
  target_status?: 'queued' | 'parked';
}

export function releaseBacklogItem(
  input: ReleaseBacklogInput,
): BacklogReleaseResult {
  const existing = db().getBacklogItem(input.id);
  if (!existing) return { ok: false, reason: 'not-found' };
  if (existing.status !== 'in-flight') {
    return { ok: false, reason: 'not-in-flight', row: existing };
  }
  if (existing.claimed_by !== input.claimed_by) {
    return { ok: false, reason: 'not-owner', row: existing };
  }
  const changed = db().releaseBacklogItem({
    id: input.id,
    claimed_by: input.claimed_by,
    target_status: input.target_status ?? 'queued',
  });
  if (changed === 0) {
    return { ok: false, reason: 'not-in-flight', row: existing };
  }
  const row = db().getBacklogItem(input.id);
  return { ok: true, row: row ?? undefined };
}

export interface MarkDoneInput {
  id: string;
  claimed_by?: string | null;
  commit_shas?: string[] | null;
  notes?: string | null;
}

export function markBacklogDone(
  input: MarkDoneInput,
): BacklogDoneResult {
  const existing = db().getBacklogItem(input.id);
  if (!existing) return { ok: false, reason: 'not-found' };
  if (existing.status !== 'in-flight') {
    return { ok: false, reason: 'not-in-flight', row: existing };
  }
  if (
    input.claimed_by &&
    existing.claimed_by &&
    existing.claimed_by !== input.claimed_by
  ) {
    return { ok: false, reason: 'not-owner', row: existing };
  }
  const commitShasJson = input.commit_shas
    ? JSON.stringify(input.commit_shas)
    : null;
  const changed = db().markBacklogItemDone({
    id: input.id,
    claimed_by: input.claimed_by ?? null,
    done_at: new Date().toISOString(),
    commit_shas: commitShasJson,
    notes: input.notes ?? null,
  });
  if (changed === 0) {
    return { ok: false, reason: 'not-in-flight', row: existing };
  }
  const row = db().getBacklogItem(input.id);
  return { ok: true, row: row ?? undefined };
}
