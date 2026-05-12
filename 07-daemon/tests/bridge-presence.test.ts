/**
 * Bridge presence resolver tests (PROJECT-ANCHORS.md step 2).
 *
 * Drives reconcileBridgePresence end-to-end against a temp DB seeded
 * with project_session rows by migration 019, simulating presence
 * files written by the VS Code bridge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  reconcileBridgePresence,
  readPresenceDir,
  groupByCwd,
  decodeBridgeMarker,
} from '../src/dashboard/bridge-presence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

interface Env {
  tmpDir: string;
  dbFile: string;
  homeDir: string;
  projectsRoot: string;
  presenceDir: string;
  priorUserprofile: string | undefined;
  priorHome: string | undefined;
  priorProjectsRoot: string | undefined;
  priorDataRoot: string | undefined;
}

let env: Env;
let db: IndexDb;

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-presence-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const homeDir = path.join(tmpDir, 'home');
  const projectsRoot = path.join(tmpDir, 'Projects');
  const presenceDir = path.join(tmpDir, '.bridge-presence');
  fs.mkdirSync(path.join(homeDir, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(presenceDir, { recursive: true });

  env = {
    tmpDir,
    dbFile,
    homeDir,
    projectsRoot,
    presenceDir,
    priorUserprofile: process.env.USERPROFILE,
    priorHome: process.env.HOME,
    priorProjectsRoot: process.env.DEVNEURAL_PROJECTS_ROOT,
    priorDataRoot: process.env.DEVNEURAL_DATA_ROOT,
  };
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = projectsRoot.replace(/\\/g, '/');
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;

  /* Pre-create the IndexDb so its inline migrate runs once, then run
   * the versioned runner so 019 applies on top. */
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });

  db = new IndexDb(dbFile);

  /* Manually insert anchors at known cwds for deterministic tests
   * (migration 019 also seeds from projectsRoot subdirs but tests
   * want explicit control). */
  db.insertProjectSession({
    id: 'anchor-A',
    project_slug: 'proj-a',
    cwd: 'C:/dev/Projects/proj-a',
    title: 'proj-a',
    status: 'dormant',
    current_session_id: null,
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1,
    last_seen_ms: 1,
  });
  db.insertProjectSession({
    id: 'anchor-B',
    project_slug: 'proj-b',
    cwd: 'C:/dev/Projects/proj-b',
    title: 'proj-b',
    status: 'dormant',
    current_session_id: null,
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1,
    last_seen_ms: 1,
  });
});

afterEach(() => {
  db.close();
  const restore = (
    k: 'USERPROFILE' | 'HOME' | 'DEVNEURAL_PROJECTS_ROOT' | 'DEVNEURAL_DATA_ROOT',
    v: string | undefined,
  ) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('USERPROFILE', env.priorUserprofile);
  restore('HOME', env.priorHome);
  restore('DEVNEURAL_PROJECTS_ROOT', env.priorProjectsRoot);
  restore('DEVNEURAL_DATA_ROOT', env.priorDataRoot);
  fs.rmSync(env.tmpDir, { recursive: true, force: true });
});

function writePresence(
  filename: string,
  payload: Record<string, unknown>,
  mtimeMs?: number,
): string {
  const file = path.join(env.presenceDir, filename);
  fs.writeFileSync(file, JSON.stringify(payload), 'utf-8');
  if (mtimeMs !== undefined) {
    const t = new Date(mtimeMs);
    fs.utimesSync(file, t, t);
  }
  return file;
}

describe('readPresenceDir', () => {
  it('parses valid presence files and skips stale ones', () => {
    const now = 1_000_000;
    writePresence(
      'fresh.json',
      {
        workspace: 'C:/dev/Projects/proj-a',
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'b1',
        updated_at: new Date(now - 1000).toISOString(),
      },
      now - 1000,
    );
    writePresence(
      'stale.json',
      {
        workspace: 'C:/dev/Projects/old',
        cwd: 'C:/dev/Projects/old',
        bridge_id: 'b2',
      },
      now - 60_000,
    );
    writePresence(
      'no-bridge-id.json',
      { cwd: 'C:/dev/Projects/bad' },
      now - 500,
    );

    const records = readPresenceDir(env.presenceDir, now, 30_000);
    const ids = records.map((r) => r.bridgeId).sort();
    expect(ids).toEqual(['b1']);
  });

  it('normalises cwd: backslashes -> slashes, strips trailing slash', () => {
    const now = 1_000_000;
    writePresence(
      'p.json',
      {
        cwd: 'C:\\dev\\Projects\\proj-a\\',
        bridge_id: 'b1',
      },
      now,
    );
    const [r] = readPresenceDir(env.presenceDir, now, 30_000);
    expect(r?.cwd).toBe('C:/dev/Projects/proj-a');
  });

  it('returns empty when dir missing or unreadable', () => {
    const records = readPresenceDir(
      path.join(env.tmpDir, 'does-not-exist'),
      Date.now(),
      30_000,
    );
    expect(records).toEqual([]);
  });
});

describe('reconcileBridgePresence', () => {
  it('flips matching anchor to live and fills current_bridge_id + current_session_id', () => {
    const now = 2_000_000;
    writePresence(
      'window1.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'bridge-w1',
        cc_session_ids: ['cc-1111-1111'],
      },
      now,
    );

    const result = reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });

    expect(result.liveAnchorIds).toEqual(['anchor-A']);
    expect(result.dormantAnchorIds).toEqual([]);

    const row = db.getProjectSession('anchor-A')!;
    expect(row.status).toBe('live');
    expect(row.current_bridge_id).toBe('bridge-w1');
    expect(row.current_session_id).toBe('cc-1111-1111');
    expect(row.last_seen_ms).toBe(now);
  });

  it('encodes connection count when multiple bridges share a cwd', () => {
    const now = 3_000_000;
    writePresence(
      'window1.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'bridge-w1',
        cc_session_ids: ['cc-1111'],
        updated_at: new Date(now - 5000).toISOString(),
      },
      now - 5000,
    );
    writePresence(
      'window2.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'bridge-w2',
        cc_session_ids: ['cc-2222'],
        updated_at: new Date(now - 1000).toISOString(),
      },
      now - 1000,
    );

    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });

    const row = db.getProjectSession('anchor-A')!;
    expect(row.status).toBe('live');
    const decoded = decodeBridgeMarker(row.current_bridge_id);
    expect(decoded.count).toBe(2);
    /* Primary is the most recently updated bridge. */
    expect(decoded.primaryBridgeId).toBe('bridge-w2');
    expect(row.current_session_id).toBe('cc-2222');
  });

  it('flips previously live anchors back to dormant when their bridge file disappears', () => {
    const now = 4_000_000;
    /* First reconcile: presence file exists, anchor flips live. */
    const filename = writePresence(
      'window1.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'bridge-w1',
        cc_session_ids: ['cc-aaaa'],
      },
      now - 5000,
    );
    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });
    expect(db.getProjectSession('anchor-A')!.status).toBe('live');

    /* Remove the file, reconcile again: anchor goes dormant. */
    fs.unlinkSync(filename);
    const later = now + 1000;
    const result = reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => later,
    });
    expect(result.dormantAnchorIds).toEqual(['anchor-A']);
    const row = db.getProjectSession('anchor-A')!;
    expect(row.status).toBe('dormant');
    expect(row.current_bridge_id).toBeNull();
    expect(row.current_session_id).toBeNull();
    expect(row.last_seen_ms).toBe(later);
  });

  it('flips previously live anchors back to dormant when their presence file goes stale past freshMs', () => {
    const now = 5_000_000;
    writePresence(
      'window1.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'bridge-w1',
      },
      now - 5000,
    );
    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });
    expect(db.getProjectSession('anchor-A')!.status).toBe('live');

    const later = now + 60_000;
    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => later,
    });
    expect(db.getProjectSession('anchor-A')!.status).toBe('dormant');
  });

  it('ignores presence files whose cwd has no matching anchor', () => {
    const now = 6_000_000;
    writePresence(
      'orphan.json',
      {
        cwd: 'C:/dev/Projects/unknown',
        bridge_id: 'bridge-w1',
      },
      now,
    );
    const result = reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });
    expect(result.liveAnchorIds).toEqual([]);
    expect(db.getProjectSession('anchor-A')!.status).toBe('dormant');
    expect(db.getProjectSession('anchor-B')!.status).toBe('dormant');
  });

  it('multiple anchors flip independently in a single reconcile pass', () => {
    const now = 7_000_000;
    writePresence(
      'a.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'bridge-a',
      },
      now,
    );
    writePresence(
      'b.json',
      {
        cwd: 'C:/dev/Projects/proj-b',
        bridge_id: 'bridge-b',
      },
      now,
    );
    const result = reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });
    expect(result.liveAnchorIds.sort()).toEqual(['anchor-A', 'anchor-B']);
    expect(db.getProjectSession('anchor-A')!.status).toBe('live');
    expect(db.getProjectSession('anchor-B')!.status).toBe('live');
  });

  it('preserves existing current_session_id when bridge omits cc_session_ids', () => {
    const now = 8_000_000;
    db.updateProjectSession('anchor-A', {
      status: 'live',
      current_session_id: 'prior-cc',
      current_bridge_id: 'prior-bridge',
    });
    writePresence(
      'window1.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'bridge-w1',
      },
      now,
    );
    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });
    const row = db.getProjectSession('anchor-A')!;
    expect(row.current_session_id).toBe('prior-cc');
    expect(row.current_bridge_id).toBe('bridge-w1');
  });
});

describe('groupByCwd', () => {
  it('groups records by cwd', () => {
    const records = [
      { bridgeId: 'a', cwd: 'C:/x', ccSessionIds: [], fileMtimeMs: 1, updatedAtMs: 1 },
      { bridgeId: 'b', cwd: 'C:/x', ccSessionIds: [], fileMtimeMs: 2, updatedAtMs: 2 },
      { bridgeId: 'c', cwd: 'C:/y', ccSessionIds: [], fileMtimeMs: 3, updatedAtMs: 3 },
    ];
    const grouped = groupByCwd(records);
    expect(grouped.get('C:/x')?.length).toBe(2);
    expect(grouped.get('C:/y')?.length).toBe(1);
  });
});

describe('decodeBridgeMarker', () => {
  it('decodes single-bridge form', () => {
    expect(decodeBridgeMarker('bridge-abc')).toEqual({
      primaryBridgeId: 'bridge-abc',
      count: 1,
    });
  });

  it('decodes multi-bridge form', () => {
    expect(decodeBridgeMarker('bridge-abc|3')).toEqual({
      primaryBridgeId: 'bridge-abc',
      count: 3,
    });
  });

  it('returns null primary for empty marker', () => {
    expect(decodeBridgeMarker(null)).toEqual({
      primaryBridgeId: null,
      count: 0,
    });
  });
});
