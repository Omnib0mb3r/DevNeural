/**
 * liveAnchorSessionIds — the authoritative bridge-backed worker liveness
 * used by listSessions() and the /sessions idle-filter so a bound-but-idle
 * bridge worker (e.g. right after a VS Code reload) stays on the Stream
 * Deck instead of vanishing when its StreamDeck identity file ages out.
 * See docs/bugs/2026-07-26-worker-drops-off-streamdeck-when-idle.md.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { liveAnchorSessionIds } from '../src/dashboard/sessions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let db: IndexDb;
let tmpDir: string;

function insert(
  id: string,
  status: 'live' | 'dormant',
  currentSessionId: string | null,
): void {
  db.insertProjectSession({
    id,
    project_slug: id,
    cwd: `C:/p/${id}`,
    title: null,
    status,
    current_session_id: currentSessionId,
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1_000,
    last_seen_ms: 1_000,
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-live-anchor-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('liveAnchorSessionIds', () => {
  it('returns the bound session ids of live anchors only', () => {
    insert('a', 'live', 'cc-live-1');
    insert('b', 'dormant', 'cc-dormant');
    insert('c', 'live', 'cc-live-2');
    const ids = liveAnchorSessionIds(db);
    expect(ids.has('cc-live-1')).toBe(true);
    expect(ids.has('cc-live-2')).toBe(true);
    expect(ids.has('cc-dormant')).toBe(false);
    expect(ids.size).toBe(2);
  });

  it('skips live anchors that have no bound session id yet', () => {
    insert('a', 'live', null);
    insert('b', 'live', 'cc-live-1');
    const ids = liveAnchorSessionIds(db);
    expect(ids.has('cc-live-1')).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('is empty when no anchor is live', () => {
    insert('a', 'dormant', 'cc-x');
    expect(liveAnchorSessionIds(db).size).toBe(0);
  });
});
