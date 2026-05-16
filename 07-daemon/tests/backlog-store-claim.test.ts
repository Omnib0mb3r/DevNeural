/* Lex backlog store: atomic claim under concurrent callers.
 *
 * Phase 2 of the autonomous supervisor work moved the backlog off
 * c:/tmp/lex-backlog-queue.json into sqlite. The load-bearing piece
 * is claimBacklogItem: when two callers race to claim the same id,
 * exactly one must succeed and the other must observe a typed
 * already-claimed result. File-CAS on Windows could not guarantee
 * this; sqlite's serialised writers + the WHERE clause on the
 * UPDATE statement do.
 *
 * Tests pin:
 *   - happy-path claim flips status to in-flight, stamps
 *     claimed_by / claimed_at / injected_at.
 *   - second claim against the same id loses with
 *     reason=already-claimed and the winning claimant's row.
 *   - 10x concurrent claims against the same id produce exactly
 *     ONE ok=true; the other nine all observe already-claimed.
 *   - claim against a non-existent id returns not-found.
 *   - claim against a done / parked row returns wrong-status.
 *   - release flips back to queued and frees the claim only when
 *     the caller owns it.
 *   - markBacklogDone retires an in-flight row owned by the same
 *     claimant and records commit_shas.
 *   - addBacklogItem produces a queued row visible via listBacklog.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  addBacklogItem,
  claimBacklogItem,
  listBacklog,
  markBacklogDone,
  releaseBacklogItem,
  setStore,
} from '../src/lex/backlog-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-backlog-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  setStore({ db });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedQueued(id: string, title = `task ${id}`): void {
  addBacklogItem({ id, title, priority: 'urgent' });
}

describe('claimBacklogItem (atomic)', () => {
  it('flips a queued row to in-flight on a happy-path claim', () => {
    seedQueued('a');
    const result = claimBacklogItem({ id: 'a', claimed_by: 'lex-1' });
    expect(result.ok).toBe(true);
    expect(result.row?.status).toBe('in-flight');
    expect(result.row?.claimed_by).toBe('lex-1');
    expect(result.row?.claimed_at).toBeTruthy();
    expect(result.row?.injected_at).toBeTruthy();
  });

  it('rejects the second claim against the same id with already-claimed', () => {
    seedQueued('b');
    const first = claimBacklogItem({ id: 'b', claimed_by: 'lex-1' });
    const second = claimBacklogItem({ id: 'b', claimed_by: 'lex-2' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already-claimed');
    expect(second.row?.claimed_by).toBe('lex-1');
  });

  it('returns not-found for an unknown id', () => {
    const r = claimBacklogItem({ id: 'ghost', claimed_by: 'lex-1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-found');
  });

  it('returns wrong-status for a done row', () => {
    seedQueued('c');
    claimBacklogItem({ id: 'c', claimed_by: 'lex-1' });
    markBacklogDone({ id: 'c', claimed_by: 'lex-1' });
    const r = claimBacklogItem({ id: 'c', claimed_by: 'lex-2' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong-status');
    expect(r.row?.status).toBe('done');
  });

  it('exactly one of N concurrent claimers wins', () => {
    /* Better-sqlite3 runs synchronously per-call, so "concurrent"
     * in this harness means firing N claim attempts back-to-back
     * with no awaits between them. The atomic primitive relies on
     * the UPDATE ... WHERE status='queued' clause re-evaluating
     * on every attempt: the first observed status=queued; the
     * next ones see status=in-flight and the UPDATE matches no
     * rows. */
    seedQueued('race');
    const N = 10;
    const results = Array.from({ length: N }, (_, i) =>
      claimBacklogItem({ id: 'race', claimed_by: `lex-${i}` }),
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);
    for (const r of losers) {
      expect(r.reason).toBe('already-claimed');
    }
    /* All losers should report the same winning claimant in
     * row.claimed_by so the dashboard panel can render a typed
     * "owned by X" toast. */
    const winnerName = winners[0]!.row!.claimed_by;
    for (const r of losers) {
      expect(r.row?.claimed_by).toBe(winnerName);
    }
  });

  it('refuses claim with no claim fields supplied', () => {
    seedQueued('d');
    const r = claimBacklogItem({
      id: '',
      claimed_by: '',
    } as Parameters<typeof claimBacklogItem>[0]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-claim-fields');
  });
});

describe('releaseBacklogItem', () => {
  it('flips an in-flight row back to queued for the owning claimant', () => {
    seedQueued('e');
    claimBacklogItem({ id: 'e', claimed_by: 'lex-1' });
    const r = releaseBacklogItem({ id: 'e', claimed_by: 'lex-1' });
    expect(r.ok).toBe(true);
    expect(r.row?.status).toBe('queued');
    expect(r.row?.claimed_by).toBeNull();
  });

  it('refuses release for a non-owner', () => {
    seedQueued('f');
    claimBacklogItem({ id: 'f', claimed_by: 'lex-1' });
    const r = releaseBacklogItem({ id: 'f', claimed_by: 'lex-2' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-owner');
    expect(r.row?.claimed_by).toBe('lex-1');
  });

  it('refuses release for a row not currently in-flight', () => {
    seedQueued('g');
    const r = releaseBacklogItem({ id: 'g', claimed_by: 'lex-1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-in-flight');
  });

  it('parks the row when target_status=parked', () => {
    seedQueued('h');
    claimBacklogItem({ id: 'h', claimed_by: 'lex-1' });
    const r = releaseBacklogItem({
      id: 'h',
      claimed_by: 'lex-1',
      target_status: 'parked',
    });
    expect(r.ok).toBe(true);
    expect(r.row?.status).toBe('parked');
  });
});

describe('markBacklogDone', () => {
  it('retires an in-flight row + persists commit_shas', () => {
    seedQueued('i');
    claimBacklogItem({ id: 'i', claimed_by: 'lex-1' });
    const r = markBacklogDone({
      id: 'i',
      claimed_by: 'lex-1',
      commit_shas: ['abcd123', 'def4567'],
    });
    expect(r.ok).toBe(true);
    expect(r.row?.status).toBe('done');
    expect(r.row?.done_at).toBeTruthy();
    expect(JSON.parse(r.row?.commit_shas ?? '[]')).toEqual([
      'abcd123',
      'def4567',
    ]);
  });

  it('refuses done flip for a non-owner', () => {
    seedQueued('j');
    claimBacklogItem({ id: 'j', claimed_by: 'lex-1' });
    const r = markBacklogDone({
      id: 'j',
      claimed_by: 'lex-2',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-owner');
  });

  it('refuses done flip for a row not in flight', () => {
    seedQueued('k');
    const r = markBacklogDone({ id: 'k', claimed_by: 'lex-1' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-in-flight');
  });
});

describe('listBacklog + addBacklogItem', () => {
  it('addBacklogItem creates a queued row visible via listBacklog', () => {
    const row = addBacklogItem({
      id: 'new-x',
      title: 'wire the supervisor',
      priority: 'urgent',
    });
    expect(row.status).toBe('queued');
    expect(row.priority).toBe('urgent');
    const items = listBacklog();
    expect(items.find((r) => r.id === 'new-x')).toBeDefined();
  });

  it('listBacklog filters by status', () => {
    addBacklogItem({ id: 'q-1', title: 'queued one' });
    addBacklogItem({ id: 'q-2', title: 'queued two' });
    claimBacklogItem({ id: 'q-1', claimed_by: 'lex-1' });
    const inflight = listBacklog({ status: 'in-flight' });
    const queued = listBacklog({ status: 'queued' });
    expect(inflight.map((r) => r.id)).toEqual(['q-1']);
    expect(queued.map((r) => r.id)).toEqual(['q-2']);
  });

  it('auto-generates an id when one is not supplied', () => {
    const row = addBacklogItem({ title: 'unnamed' });
    expect(typeof row.id).toBe('string');
    expect(row.id.length).toBeGreaterThan(0);
    expect(row.status).toBe('queued');
  });
});
