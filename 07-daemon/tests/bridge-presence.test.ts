/**
 * Bridge presence resolver tests (PROJECT-ANCHORS.md step 2).
 *
 * Drives reconcileBridgePresence end-to-end against a temp DB seeded
 * with project_session rows by migration 019, simulating presence
 * files written by the VS Code bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  startBridgePresenceLoop,
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

  it('canonicalises a lowercase drive letter to uppercase (VS Code fsPath)', () => {
    const now = 1_000_000;
    writePresence(
      'lower.json',
      { cwd: 'c:/dev/Projects/proj-a', bridge_id: 'b1' },
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

  it('flips an uppercase-seeded anchor live from a lowercase-drive presence cwd (regression: VS Code emits c:/, registry stores C:/)', () => {
    const now = 2_000_000;
    writePresence(
      'lowerdrive.json',
      {
        cwd: 'c:/dev/Projects/proj-a',
        bridge_id: 'bridge-lower',
        cc_session_ids: ['cc-2222-2222'],
      },
      now,
    );

    const result = reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });

    expect(result.liveAnchorIds).toEqual(['anchor-A']);
    const row = db.getProjectSession('anchor-A')!;
    expect(row.status).toBe('live');
    expect(row.current_session_id).toBe('cc-2222-2222');
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

  it('auto-creates an anchor for a presence file whose cwd is unseeded, leaving pre-seeded anchors dormant (PROJECT-ANCHORS seeding)', () => {
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
    /* The unseeded cwd now produces an inline anchor and a live flip
     * in the same pass instead of being silently dropped. The two
     * pre-seeded anchors (proj-a, proj-b) had no presence file so
     * they stay dormant. */
    const created = db.getProjectSessionByCwd('C:/dev/Projects/unknown');
    expect(created).not.toBeNull();
    expect(created?.status).toBe('live');
    expect(created?.current_bridge_id).toBe('bridge-w1');
    expect(result.liveAnchorIds).toEqual([created!.id]);
    expect(db.getProjectSession('anchor-A')!.status).toBe('dormant');
    expect(db.getProjectSession('anchor-B')!.status).toBe('dormant');
  });

  it('reuses an anchor whose stored cwd differs only by drive-letter case instead of minting a duplicate (R3)', () => {
    /* Simulate a pre-fix legacy row: inserted directly with a
     * lowercase drive letter, bypassing normalizeCwd entirely (the
     * historical bug this test guards against). */
    db.insertProjectSession({
      id: 'anchor-case',
      project_slug: 'proj-case',
      cwd: 'c:/dev/Projects/proj-case',
      title: 'proj-case',
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
    const before = db.listProjectSessions({ limit: 1000 }).length;

    const now = 4_800_000;
    writePresence(
      'case-window.json',
      {
        cwd: 'C:/dev/Projects/proj-case',
        bridge_id: 'bridge-case',
        cc_session_ids: ['cc-case-1'],
      },
      now,
    );
    const result = reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });

    /* The exact-match lookup on the normalized cwd would miss the
     * lowercase-drive row and, pre-fix, fall through to
     * ensureAnchorForCwd and create a SECOND row for the same
     * directory. Post-fix: the existing row is reused, row count is
     * unchanged, and it is the one that flips live. */
    const after = db.listProjectSessions({ limit: 1000 }).length;
    expect(after).toBe(before);
    expect(result.liveAnchorIds).toEqual(['anchor-case']);
    const row = db.getProjectSession('anchor-case')!;
    expect(row.status).toBe('live');
    expect(row.current_bridge_id).toBe('bridge-case');
    expect(row.current_session_id).toBe('cc-case-1');
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

  it('inserts project_transcript_ref on live transition with cc_session_id', () => {
    const now = 9_000_000;
    writePresence(
      'window1.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'b-1',
        cc_session_ids: ['cc-live-1'],
      },
      now,
    );

    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });

    const refs = db.listProjectTranscriptRefs('anchor-A');
    expect(refs.length).toBe(1);
    expect(refs[0]!.cc_session_id).toBe('cc-live-1');
    expect(refs[0]!.anchor_id).toBe('anchor-A');
    expect(refs[0]!.opened_ms).toBe(now);
    expect(refs[0]!.closed_ms).toBeNull();
  });

  it('does not duplicate project_transcript_ref across repeated reconciles', () => {
    const now = 9_100_000;
    writePresence(
      'window1.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'b-1',
        cc_session_ids: ['cc-live-1'],
      },
      now,
    );

    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });
    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now + 1,
    });

    expect(db.listProjectTranscriptRefs('anchor-A').length).toBe(1);
  });

  it('closes project_transcript_ref when anchor flips dormant', () => {
    const now = 9_200_000;
    const filename = writePresence(
      'window1.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'b-1',
        cc_session_ids: ['cc-live-1'],
      },
      now,
    );

    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });
    fs.unlinkSync(filename);
    const later = now + 1000;
    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => later,
    });

    const refs = db.listProjectTranscriptRefs('anchor-A');
    expect(refs.length).toBe(1);
    expect(refs[0]!.closed_ms).toBe(later);
  });

  it('closes prior transcript_ref and opens new one when cc_session_id changes', () => {
    const t1 = 9_300_000;
    writePresence(
      'window1.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'b-1',
        cc_session_ids: ['cc-old'],
      },
      t1,
    );
    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => t1,
    });

    const t2 = t1 + 5000;
    writePresence(
      'window1.json',
      {
        cwd: 'C:/dev/Projects/proj-a',
        bridge_id: 'b-1',
        cc_session_ids: ['cc-new'],
      },
      t2,
    );
    reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => t2,
    });

    const refs = db.listProjectTranscriptRefs('anchor-A');
    expect(refs.length).toBe(2);
    const byCc = new Map(refs.map((r) => [r.cc_session_id, r]));
    expect(byCc.get('cc-old')!.closed_ms).toBe(t2);
    expect(byCc.get('cc-new')!.closed_ms).toBeNull();
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

  it('auto-creates anchor for unknown cwd and flips it live in the same pass (PROJECT-ANCHORS seeding)', () => {
    const now = 4_500_000;
    const unknownCwd = 'C:/dev/Projects/just-cloned-repo';
    expect(db.getProjectSessionByCwd(unknownCwd)).toBeNull();

    writePresence(
      'new-window.json',
      {
        cwd: unknownCwd,
        bridge_id: 'bridge-new',
        cc_session_ids: ['cc-2222-2222'],
        updated_at: new Date(now - 100).toISOString(),
      },
      now,
    );

    const result = reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });

    const created = db.getProjectSessionByCwd(unknownCwd);
    expect(created).not.toBeNull();
    expect(created?.status).toBe('live');
    expect(created?.current_bridge_id).toBe('bridge-new');
    expect(created?.current_session_id).toBe('cc-2222-2222');
    expect(created?.project_slug).toBe('just-cloned-repo');
    expect(result.liveAnchorIds).toContain(created!.id);
  });

  it('reports presenceRecordCount = total fresh records read this pass, before grouping by cwd', () => {
    const now = 4_900_000;
    writePresence('a.json', { cwd: 'C:/dev/Projects/proj-a', bridge_id: 'bridge-a' }, now);
    writePresence('b.json', { cwd: 'C:/dev/Projects/proj-b', bridge_id: 'bridge-b' }, now);
    const result = reconcileBridgePresence(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      now: () => now,
    });
    expect(result.presenceRecordCount).toBe(2);
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

describe('startBridgePresenceLoop heartbeat (observability hardening F3)', () => {
  /* F3: the 1s reconcile loop logged errors only, so a quiet
   * daemon.log was ambiguous between "healthy, nothing to do" and
   * "the timer died". These pins lock in an hourly INFO heartbeat
   * built from data reconcile already returns, without touching the
   * 1s reconcile cadence itself. */
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays silent before the heartbeat interval elapses, then logs using data reconcile already computed', () => {
    vi.useFakeTimers();
    const start = 10_000_000;
    vi.setSystemTime(start);
    /* freshMs generously wide so the presence file stays "fresh"
     * across the whole simulated hour; the point of this test is the
     * heartbeat cadence, not presence staleness. */
    writePresence(
      'window1.json',
      { cwd: 'C:/dev/Projects/proj-a', bridge_id: 'bridge-w1' },
      start,
    );

    const log = vi.fn();
    const loop = startBridgePresenceLoop(db, {
      presenceDir: env.presenceDir,
      freshMs: 4 * 60 * 60_000,
      intervalMs: 1_000,
      heartbeatMs: 60 * 60_000,
      log,
    });

    vi.advanceTimersByTime(59 * 60_000);
    expect(log).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2 * 60_000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[bridge-presence] tick ok live=1 presences=1');

    loop.stop();
  });

  it('repeats the heartbeat on each subsequent interval rather than firing once', () => {
    vi.useFakeTimers();
    const start = 20_000_000;
    vi.setSystemTime(start);
    writePresence(
      'window1.json',
      { cwd: 'C:/dev/Projects/proj-a', bridge_id: 'bridge-w1' },
      start,
    );

    const log = vi.fn();
    const loop = startBridgePresenceLoop(db, {
      presenceDir: env.presenceDir,
      freshMs: 6 * 60 * 60_000,
      intervalMs: 1_000,
      heartbeatMs: 60 * 60_000,
      log,
    });

    vi.advanceTimersByTime(61 * 60_000);
    expect(log).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60_000);
    expect(log).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it('does not change the 1s reconcile cadence: anchor still flips live on the first tick, heartbeat aside', () => {
    vi.useFakeTimers();
    const start = 30_000_000;
    vi.setSystemTime(start);
    writePresence(
      'window1.json',
      { cwd: 'C:/dev/Projects/proj-a', bridge_id: 'bridge-w1' },
      start,
    );

    const loop = startBridgePresenceLoop(db, {
      presenceDir: env.presenceDir,
      freshMs: 30_000,
      intervalMs: 1_000,
      heartbeatMs: 60 * 60_000,
    });

    vi.advanceTimersByTime(1_000);
    expect(db.getProjectSession('anchor-A')!.status).toBe('live');

    loop.stop();
  });
});
