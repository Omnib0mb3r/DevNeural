/**
 * Project anchor route handlers (PROJECT-ANCHORS.md step 3).
 *
 * Tests the pure handler logic exported from projects-routes.ts
 * without spinning up Fastify — those exports own all the behaviour,
 * the route-registration shim is a thin wrapper.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  listProjectAnchors,
  getProjectAnchorDetail,
  openProjectAnchor,
  endProjectAnchor,
  patchProjectAnchor,
  deleteProjectAnchor,
  toAnchorView,
  createOpenInFlightMap,
} from '../src/dashboard/projects-routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

interface Env {
  tmpDir: string;
  dbFile: string;
  homeDir: string;
  projectsRoot: string;
  priorUserprofile: string | undefined;
  priorHome: string | undefined;
  priorProjectsRoot: string | undefined;
  priorDataRoot: string | undefined;
}

let env: Env;
let db: IndexDb;

beforeEach(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-proj-routes-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const homeDir = path.join(tmpDir, 'home');
  const projectsRoot = path.join(tmpDir, 'Projects');
  fs.mkdirSync(path.join(homeDir, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(path.join(projectsRoot, 'proj-a'), { recursive: true });

  env = {
    tmpDir,
    dbFile,
    homeDir,
    projectsRoot,
    priorUserprofile: process.env.USERPROFILE,
    priorHome: process.env.HOME,
    priorProjectsRoot: process.env.DEVNEURAL_PROJECTS_ROOT,
    priorDataRoot: process.env.DEVNEURAL_DATA_ROOT,
  };
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = projectsRoot.replace(/\\/g, '/');
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;

  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  /* Migration 019 seeded the proj-a subdirectory as a dormant anchor.
   * Tests want a clean slate so they can insert a known-id row at the
   * same cwd; drop the seeded rows. */
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } }).db
    .prepare('DELETE FROM project_session')
    .run();
  db.insertProjectSession({
    id: 'anchor-A',
    project_slug: 'proj-a',
    cwd: path.join(projectsRoot, 'proj-a').replace(/\\/g, '/'),
    title: 'proj-a',
    status: 'dormant',
    current_session_id: null,
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1000,
    last_seen_ms: 1000,
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

describe('toAnchorView', () => {
  it('decodes a single-bridge marker into bridge_connection_count=1', () => {
    db.updateProjectSession('anchor-A', {
      status: 'live',
      current_bridge_id: 'bridge-1',
      current_session_id: 'cc-abc',
    });
    const view = toAnchorView(db.getProjectSession('anchor-A')!);
    expect(view.status).toBe('live');
    expect(view.current_bridge_id).toBe('bridge-1');
    expect(view.bridge_connection_count).toBe(1);
    expect(view.current_session_id).toBe('cc-abc');
    expect(view.exists_on_disk).toBe(true);
  });

  it('decodes multi-bridge marker into bridge_connection_count=N', () => {
    db.updateProjectSession('anchor-A', {
      status: 'live',
      current_bridge_id: 'bridge-1|3',
    });
    const view = toAnchorView(db.getProjectSession('anchor-A')!);
    expect(view.current_bridge_id).toBe('bridge-1');
    expect(view.bridge_connection_count).toBe(3);
  });

  it('reports exists_on_disk=false when the cwd is missing', () => {
    db.insertProjectSession({
      id: 'anchor-gone',
      project_slug: 'gone',
      cwd: 'C:/does/not/exist',
      title: 'gone',
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
    const view = toAnchorView(db.getProjectSession('anchor-gone')!);
    expect(view.exists_on_disk).toBe(false);
  });
});

describe('listProjectAnchors / getProjectAnchorDetail', () => {
  it('lists anchors and filters by status', () => {
    db.insertProjectSession({
      id: 'anchor-B',
      project_slug: 'proj-b',
      cwd: 'C:/dev/Projects/proj-b',
      title: 'proj-b',
      status: 'live',
      current_session_id: 'cc-1',
      current_bridge_id: 'b-1',
      current_pty_id: null,
      created_ms: 2,
      last_seen_ms: 2,
    });
    const all = listProjectAnchors(db);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const live = listProjectAnchors(db, { status: 'live' });
    expect(live.map((a) => a.id)).toEqual(['anchor-B']);
  });

  it('detail returns transcripts list', () => {
    db.insertProjectTranscriptRef({
      id: 'ref-1',
      anchor_id: 'anchor-A',
      cc_session_id: 'cc-aaaa-bbbb',
      jsonl_path: 'X:/fake.jsonl',
      opened_ms: 1,
      closed_ms: 2,
    });
    const detail = getProjectAnchorDetail(db, 'anchor-A');
    expect(detail).not.toBeNull();
    expect(detail!.transcripts.map((r) => r.cc_session_id)).toEqual([
      'cc-aaaa-bbbb',
    ]);
  });

  it('detail returns null for unknown anchor', () => {
    expect(getProjectAnchorDetail(db, 'nope')).toBeNull();
  });
});

describe('openProjectAnchor', () => {
  let bootstrapCalls: Array<{ cwd: string; command: string }>;
  let bootstrap: (cwd: string, command: string) => void;
  /* Spawn delivery confirmation (openProjectAnchor now also polls
   * pollInjectResult, mirroring /projects/:id/start-claude) defaults
   * to a real 12s/250ms poll against real disk. Every spawn-path test
   * below queues a marker, so without an override each of these tests
   * would block on that real timeout. timeoutMs:0 + a stub reader
   * settles the poll to 'unconfirmed' on the first check with no real
   * wait -- delivery outcome itself is exercised by the dedicated
   * 'spawn delivery confirmation' describe block further down. */
  const FAST_POLL_INJECT = { timeoutMs: 0, readResultFile: (): string | null => null };
  beforeEach(() => {
    bootstrapCalls = [];
    bootstrap = (cwd, command) => {
      bootstrapCalls.push({ cwd, command });
    };
  });

  it('bind path: live anchor returns mode=bind without queueing a marker', async () => {
    db.updateProjectSession('anchor-A', {
      status: 'live',
      current_bridge_id: 'bridge-w1',
      current_session_id: 'cc-1',
    });
    const inflight = createOpenInFlightMap();
    const res = await openProjectAnchor(
      db,
      'anchor-A',
      { launchVsCode: false, waitMs: 0, pollMs: 0, bootstrapQueue: bootstrap },
      inflight,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe('bind');
    expect(res.anchor.current_bridge_id).toBe('bridge-w1');
    expect(bootstrapCalls).toEqual([]);
  });

  it('spawn path: dormant anchor queues a workspace-inject marker', async () => {
    const inflight = createOpenInFlightMap();
    const res = await openProjectAnchor(
      db,
      'anchor-A',
      {
        launchVsCode: false,
        waitMs: 50,
        pollMs: 25,
        bootstrapQueue: bootstrap,
        bridgeAlive: () => true,
        pollInjectOptions: FAST_POLL_INJECT,
      },
      inflight,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe('spawning');
    expect(res.command).toBe('claude');
    expect(bootstrapCalls.length).toBe(1);
    expect(bootstrapCalls[0]!.command).toBe('claude');
    expect(bootstrapCalls[0]!.cwd.toLowerCase()).toContain('proj-a');
  });

  it('spawn path: dangerous=true is INERT for workers; command is plain `claude` + warning', async () => {
    /* Fix 37 (2026-05-26): workers no longer bypass the permissions
     * onboarding wizard. The dashboard button may still ship
     * dangerous=true on legacy clients; daemon ignores it and surfaces
     * a warning in res.warnings so a regression that silently degrades
     * safety is loud rather than silent. Lex's own brainstorm spawn
     * is NOT affected (separate /spawn-lex + /lex/anchors paths still
     * pass extraArgs explicitly). */
    const inflight = createOpenInFlightMap();
    const res = await openProjectAnchor(
      db,
      'anchor-A',
      {
        launchVsCode: false,
        waitMs: 0,
        pollMs: 0,
        dangerous: true,
        bootstrapQueue: bootstrap,
        bridgeAlive: () => true,
        pollInjectOptions: FAST_POLL_INJECT,
      },
      inflight,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.command).toBe('claude');
    expect(bootstrapCalls[0]!.command).toBe('claude');
    expect(res.warnings ?? []).toContain(
      'skip-permissions ignored: workers no longer accept --dangerously-skip-permissions per architectural rule (2026-05-26)',
    );
  });

  it('spawn path: flips to mode=spawn when bridge presence flips anchor live during poll', async () => {
    const inflight = createOpenInFlightMap();
    setTimeout(() => {
      db.updateProjectSession('anchor-A', {
        status: 'live',
        current_bridge_id: 'bridge-late',
        current_session_id: 'cc-late',
      });
    }, 40);
    const res = await openProjectAnchor(
      db,
      'anchor-A',
      {
        launchVsCode: false,
        waitMs: 500,
        pollMs: 25,
        bootstrapQueue: bootstrap,
        bridgeAlive: () => true,
        pollInjectOptions: FAST_POLL_INJECT,
      },
      inflight,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe('spawn');
    expect(res.anchor.current_bridge_id).toBe('bridge-late');
  });

  it('openInFlight collapses concurrent calls into one queued marker', async () => {
    const inflight = createOpenInFlightMap();
    const openOpts = {
      launchVsCode: false,
      waitMs: 100,
      pollMs: 25,
      bootstrapQueue: bootstrap,
      bridgeAlive: () => true,
      pollInjectOptions: FAST_POLL_INJECT,
    };
    const [a, b, c] = await Promise.all([
      openProjectAnchor(db, 'anchor-A', openOpts, inflight),
      openProjectAnchor(db, 'anchor-A', openOpts, inflight),
      openProjectAnchor(db, 'anchor-A', openOpts, inflight),
    ]);
    for (const r of [a, b, c]) expect(r.ok).toBe(true);
    expect(bootstrapCalls.length).toBe(1);
  });

  it('returns ok=false with error for unknown anchor', async () => {
    const inflight = createOpenInFlightMap();
    const res = await openProjectAnchor(
      db,
      'does-not-exist',
      { launchVsCode: false, waitMs: 0, pollMs: 0, bootstrapQueue: bootstrap },
      inflight,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('anchor not found');
  });
});

describe('openProjectAnchor spawn delivery confirmation (wired to pollInjectResult)', () => {
  /* Mirrors the fake-clock pattern from tests/poll-inject-result.test.ts
   * so the delivery poll (default 12s/250ms in projects-new.ts) never
   * waits on a real timer here. pollAnchorLive gets waitMs/pollMs=0 so
   * both polls settle immediately -- the anchor stays dormant (no test
   * flips status='live'), so mode is always 'spawning' in this block;
   * the point under test is the `delivery` / `bridge_error` fields the
   * route now carries alongside it. */
  let bootstrapCalls: Array<{ cwd: string; command: string }>;
  let bootstrap: (cwd: string, command: string) => void;

  function fakeClock(startMs = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let current = startMs;
    return {
      now: () => current,
      sleep: async (ms: number) => {
        current += ms;
      },
    };
  }

  beforeEach(() => {
    bootstrapCalls = [];
    bootstrap = (cwd, command) => {
      bootstrapCalls.push({ cwd, command });
    };
  });

  it('confirmed: result file reports ok:true -> delivery=confirmed, no bridge_error', async () => {
    const clock = fakeClock();
    const inflight = createOpenInFlightMap();
    const res = await openProjectAnchor(
      db,
      'anchor-A',
      {
        launchVsCode: false,
        waitMs: 0,
        pollMs: 0,
        bootstrapQueue: bootstrap,
        bridgeAlive: () => true,
        pollInjectOptions: {
          now: clock.now,
          sleep: clock.sleep,
          readResultFile: () =>
            JSON.stringify({ ok: true, at: '2026-07-15T00:00:00.000Z', workspace: 'x' }),
        },
      },
      inflight,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe('spawning');
    expect(res.delivery).toBe('confirmed');
    expect(res.bridge_error).toBeUndefined();
    expect(res.warnings ?? []).not.toContain('bridge_offline');
    expect(bootstrapCalls.length).toBe(1);
  });

  it('failed: result file reports ok:false -> delivery=failed, bridge_error carries the bridge detail', async () => {
    const clock = fakeClock();
    const inflight = createOpenInFlightMap();
    const res = await openProjectAnchor(
      db,
      'anchor-A',
      {
        launchVsCode: false,
        waitMs: 0,
        pollMs: 0,
        bootstrapQueue: bootstrap,
        bridgeAlive: () => true,
        pollInjectOptions: {
          now: clock.now,
          sleep: clock.sleep,
          readResultFile: () =>
            JSON.stringify({ ok: false, error: 'no active terminal', at: 'x', workspace: 'x' }),
        },
      },
      inflight,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delivery).toBe('failed');
    expect(res.bridge_error).toBe('no active terminal');
  });

  it('timeout: no result file ever appears -> delivery=unconfirmed, no bridge_error', async () => {
    const clock = fakeClock();
    const inflight = createOpenInFlightMap();
    const res = await openProjectAnchor(
      db,
      'anchor-A',
      {
        launchVsCode: false,
        waitMs: 0,
        pollMs: 0,
        bootstrapQueue: bootstrap,
        bridgeAlive: () => true,
        pollInjectOptions: {
          now: clock.now,
          sleep: clock.sleep,
          timeoutMs: 500,
          intervalMs: 100,
          readResultFile: () => null,
        },
      },
      inflight,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.delivery).toBe('unconfirmed');
    expect(res.bridge_error).toBeUndefined();
  });

  it('bridge-liveness precheck: no live bridge -> warnings contains bridge_offline alongside the delivery fields', async () => {
    const clock = fakeClock();
    const inflight = createOpenInFlightMap();
    const res = await openProjectAnchor(
      db,
      'anchor-A',
      {
        launchVsCode: false,
        waitMs: 0,
        pollMs: 0,
        bootstrapQueue: bootstrap,
        bridgeAlive: () => false,
        pollInjectOptions: {
          now: clock.now,
          sleep: clock.sleep,
          timeoutMs: 0,
          readResultFile: () => null,
        },
      },
      inflight,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.warnings ?? []).toContain('bridge_offline');
    expect(res.delivery).toBe('unconfirmed');
  });

  it('bind path never calls pollInjectResult: delivery is absent when an already-live anchor short-circuits to mode=bind', async () => {
    db.updateProjectSession('anchor-A', {
      status: 'live',
      current_bridge_id: 'bridge-w1',
      current_session_id: 'cc-1',
    });
    const inflight = createOpenInFlightMap();
    const res = await openProjectAnchor(
      db,
      'anchor-A',
      { launchVsCode: false, waitMs: 0, pollMs: 0, bootstrapQueue: bootstrap },
      inflight,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe('bind');
    expect(res.delivery).toBeUndefined();
    expect(bootstrapCalls).toEqual([]);
  });
});

describe('endProjectAnchor', () => {
  it('flips status to dormant and clears current_* fields', () => {
    db.updateProjectSession('anchor-A', {
      status: 'live',
      current_bridge_id: 'bridge-1',
      current_session_id: 'cc-1',
      current_pty_id: 'pty-1',
    });
    const view = endProjectAnchor(db, 'anchor-A', { now: () => 9999 });
    expect(view).not.toBeNull();
    expect(view!.status).toBe('dormant');
    expect(view!.current_bridge_id).toBeNull();
    expect(view!.current_session_id).toBeNull();
    expect(view!.current_pty_id).toBeNull();
    expect(view!.last_seen_ms).toBe(9999);
  });

  it('returns null for unknown anchor', () => {
    expect(endProjectAnchor(db, 'nope')).toBeNull();
  });
});

describe('patchProjectAnchor', () => {
  it('updates title only', () => {
    const view = patchProjectAnchor(db, 'anchor-A', { title: 'Renamed' });
    expect(view).not.toBeNull();
    expect(view!.title).toBe('Renamed');
  });

  it('returns existing row when no patch fields supplied', () => {
    const view = patchProjectAnchor(db, 'anchor-A', {});
    expect(view!.title).toBe('proj-a');
  });
});

describe('deleteProjectAnchor', () => {
  it('removes the anchor and cascades transcripts', () => {
    db.insertProjectTranscriptRef({
      id: 'ref-x',
      anchor_id: 'anchor-A',
      cc_session_id: 'cc-x',
      jsonl_path: 'X:/x.jsonl',
      opened_ms: 1,
      closed_ms: null,
    });
    expect(deleteProjectAnchor(db, 'anchor-A')).toBe(true);
    expect(db.getProjectSession('anchor-A')).toBeNull();
    expect(db.getProjectTranscriptRefByCc('cc-x')).toBeNull();
  });

  it('returns false for unknown anchor', () => {
    expect(deleteProjectAnchor(db, 'nope')).toBe(false);
  });
});
