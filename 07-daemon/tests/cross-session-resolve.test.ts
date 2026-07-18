/**
 * Fix 15 C1 — anchor-resolved cross-session inject dispatch.
 *
 * Verifies that resolveAnchorDispatch produces the three outcomes the
 * route layer needs to decide between (pass-through, redirect to
 * live, reject dormant). Migrations are run against a tmp index.db so
 * the previous_session_id column from migration 029 is available.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  resolveAnchorDispatch,
  resolveMirrorSessionId,
  workerActionItemLink,
} from '../src/lex/cross-session-resolve.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;

const LIVE_UUID = '11111111-1111-1111-1111-111111111111';
const STALE_UUID = '22222222-2222-2222-2222-222222222222';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-fix15-c1-'));
  dbFile = path.join(tmpDir, 'index.db');
  /* Legacy IndexDb constructor seeds tables (raw_chunks_meta, etc.)
   * that early SQL migrations ALTER. Open + close once so the schema
   * exists, then run the migration runner. */
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertAnchor(opts: {
  id: string;
  status: 'live' | 'dormant';
  current_session_id: string | null;
  previous_session_id?: string | null;
}): void {
  const now = Date.now();
  db.insertProjectSession({
    id: opts.id,
    project_slug: `slug-${opts.id}`,
    cwd: `/tmp/${opts.id}`,
    title: null,
    status: opts.status,
    current_session_id: opts.current_session_id,
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: now,
    last_seen_ms: now,
  });
  if (opts.previous_session_id) {
    db.updateProjectSession(opts.id, {
      previous_session_id: opts.previous_session_id,
    });
  }
}

describe('resolveAnchorDispatch (Fix 15 C1)', () => {
  it('redirects stale uuid to live current_session_id when anchor flipped', () => {
    insertAnchor({
      id: 'anchor-a',
      status: 'live',
      current_session_id: LIVE_UUID,
      previous_session_id: STALE_UUID,
    });
    const outcome = resolveAnchorDispatch(db, STALE_UUID);
    expect(outcome.kind).toBe('redirect');
    if (outcome.kind !== 'redirect') throw new Error('narrowing');
    expect(outcome.dispatch_session).toBe(LIVE_UUID);
    expect(outcome.old_session).toBe(STALE_UUID);
    expect(outcome.anchor_id).toBe('anchor-a');
  });

  it('returns dormant outcome when owning anchor has gone dormant', () => {
    insertAnchor({
      id: 'anchor-b',
      status: 'dormant',
      current_session_id: null,
      previous_session_id: STALE_UUID,
    });
    const outcome = resolveAnchorDispatch(db, STALE_UUID);
    expect(outcome.kind).toBe('dormant');
    if (outcome.kind !== 'dormant') throw new Error('narrowing');
    expect(outcome.anchor_id).toBe('anchor-b');
  });

  it('passes through when no anchor knows this session uuid', () => {
    const outcome = resolveAnchorDispatch(db, 'orphan-uuid-xxxx');
    expect(outcome.kind).toBe('pass');
    if (outcome.kind !== 'pass') throw new Error('narrowing');
    expect(outcome.dispatch_session).toBe('orphan-uuid-xxxx');
  });

  it('reports live-direct when uuid is still the anchors current session', () => {
    insertAnchor({
      id: 'anchor-c',
      status: 'live',
      current_session_id: LIVE_UUID,
    });
    const outcome = resolveAnchorDispatch(db, LIVE_UUID);
    expect(outcome.kind).toBe('live-direct');
    if (outcome.kind !== 'live-direct') throw new Error('narrowing');
    expect(outcome.dispatch_session).toBe(LIVE_UUID);
    expect(outcome.anchor_id).toBe('anchor-c');
  });

  it('resolveMirrorSessionId redirects a stale mirror uuid to the live session', () => {
    /* SESSIONS-VIEW defect 1/3: the terminal mirror binds by a session
     * uuid frozen in the URL; after /clear or restart the anchor's live
     * session moved on, so the frozen uuid's output ring is empty and
     * the mirror is blank. Resolve it to the anchor's live session so
     * the mirror binds to the ring producers actually fill. */
    insertAnchor({
      id: 'anchor-m',
      status: 'live',
      current_session_id: LIVE_UUID,
      previous_session_id: STALE_UUID,
    });
    expect(resolveMirrorSessionId(db, STALE_UUID)).toBe(LIVE_UUID);
  });

  it('resolveMirrorSessionId leaves a live-current uuid unchanged', () => {
    insertAnchor({
      id: 'anchor-n',
      status: 'live',
      current_session_id: LIVE_UUID,
    });
    expect(resolveMirrorSessionId(db, LIVE_UUID)).toBe(LIVE_UUID);
  });

  it('resolveMirrorSessionId passes through a uuid with no known anchor (bridge session)', () => {
    expect(resolveMirrorSessionId(db, 'orphan-uuid-xxxx')).toBe(
      'orphan-uuid-xxxx',
    );
  });

  it('resolveMirrorSessionId returns the raw uuid when the anchor is dormant (no live ring to bind)', () => {
    insertAnchor({
      id: 'anchor-o',
      status: 'dormant',
      current_session_id: null,
      previous_session_id: STALE_UUID,
    });
    expect(resolveMirrorSessionId(db, STALE_UUID)).toBe(STALE_UUID);
  });

  it('workerActionItemLink points a bell/action item at the STABLE anchor, and it survives a swap', () => {
    /* BELL-ACTIONABLE-ONLY task 3 (swap-pairing): an action item
     * targeting a worker must reference the stable anchor id, not the
     * ephemeral session uuid (which dies on /clear). Link to the anchor
     * page - it always resolves to the anchor's LIVE session. */
    insertAnchor({
      id: 'anchor-w',
      status: 'live',
      current_session_id: STALE_UUID,
    });
    const at = workerActionItemLink(db, STALE_UUID);
    expect(at.anchor_id).toBe('anchor-w');
    expect(at.link).toBe('/projects/anchor-w');

    /* The worker /clears: current_session_id flips to LIVE_UUID, the old
     * uuid is stashed as previous_session_id. The action item still
     * references anchor-w, which now resolves to the LIVE session. */
    db.updateProjectSession('anchor-w', {
      current_session_id: LIVE_UUID,
      previous_session_id: STALE_UUID,
    });
    expect(db.getProjectSession('anchor-w')?.current_session_id).toBe(LIVE_UUID);
    /* And the mirror/click resolver maps the item's original uuid to the
     * new live session via the anchor. */
    expect(resolveMirrorSessionId(db, STALE_UUID)).toBe(LIVE_UUID);
  });

  it('workerActionItemLink falls back to the session link when no anchor knows the session', () => {
    const at = workerActionItemLink(db, 'orphan-uuid-xxxx');
    expect(at.anchor_id).toBeNull();
    expect(at.link).toBe('/sessions/detail?id=orphan-uuid-xxxx');
  });

  it('audit log decision enum accepts new Fix 15 values', () => {
    /* Sanity: the migration that widens the CHECK constraint must
     * have applied, otherwise inserting these decisions would throw
     * a SQLITE_CONSTRAINT_CHECK error. */
    expect(() => {
      db.insertCrossSessionLog({
        id: 'r1',
        target_session: STALE_UUID,
        text_preview: 'preview',
        text_length: 7,
        decision: 'redirected',
        reject_reason: JSON.stringify({ anchor_id: 'x' }),
      });
      db.insertCrossSessionLog({
        id: 'r2',
        target_session: STALE_UUID,
        text_preview: 'preview',
        text_length: 7,
        decision: 'dispatched_dead_session',
        reject_reason: 'bound-anchor-dormant',
      });
      db.insertCrossSessionLog({
        id: 'r3',
        target_session: STALE_UUID,
        text_preview: 'preview',
        text_length: 7,
        decision: 'rejected_anchor_dormant',
        reject_reason: null,
      });
    }).not.toThrow();
  });
});
