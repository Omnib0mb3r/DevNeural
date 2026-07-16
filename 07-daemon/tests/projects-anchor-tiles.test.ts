/**
 * Project anchor tile builder (PROJECT-ANCHORS.md step 4).
 *
 * Asserts the deck-facing surface: one tile per live anchor with
 * bridge_connection_count badge, deduped by anchor id regardless of
 * how many VS Code windows attached, phase derived from the most
 * recent transcript_ref.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  listProjectAnchorTiles,
  buildProjectAnchorTile,
} from '../src/dashboard/projects-anchor-tiles.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;
let priorProjectsRoot: string | undefined;
let priorUserprofile: string | undefined;
let priorHome: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-tiles-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  priorProjectsRoot = process.env.DEVNEURAL_PROJECTS_ROOT;
  priorUserprofile = process.env.USERPROFILE;
  priorHome = process.env.HOME;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path
    .join(tmpDir, 'Projects')
    .replace(/\\/g, '/');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');

  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } }).db
    .prepare('DELETE FROM project_session')
    .run();
});

afterEach(() => {
  db.close();
  const restore = (
    k:
      | 'USERPROFILE'
      | 'HOME'
      | 'DEVNEURAL_PROJECTS_ROOT'
      | 'DEVNEURAL_DATA_ROOT',
    v: string | undefined,
  ) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('USERPROFILE', priorUserprofile);
  restore('HOME', priorHome);
  restore('DEVNEURAL_PROJECTS_ROOT', priorProjectsRoot);
  restore('DEVNEURAL_DATA_ROOT', priorRoot);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const noTail = () => 'unknown' as const;
const noPhase = () => 'unknown' as const;
const noPending = () => null;
const stubs = {
  phaseResolver: noPhase,
  tailPhaseResolver: noTail,
  pendingResolver: noPending,
};

function liveAnchor(id: string, cwd: string, marker: string | null): void {
  db.insertProjectSession({
    id,
    project_slug: id,
    cwd,
    title: id,
    status: 'live',
    current_session_id: null,
    current_bridge_id: marker,
    current_pty_id: null,
    created_ms: 1,
    last_seen_ms: 1,
  });
}

describe('listProjectAnchorTiles', () => {
  it('returns only live anchors', () => {
    liveAnchor('live-1', 'C:/p/1', 'b1');
    db.insertProjectSession({
      id: 'dormant-1',
      project_slug: 'd1',
      cwd: 'C:/p/2',
      title: 'd1',
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
    const tiles = listProjectAnchorTiles(db, stubs);
    expect(tiles.map((t) => t.anchor_id)).toEqual(['live-1']);
  });

  it("status:'all' includes dormant anchors (dashboard supervision toggle needs every anchor)", () => {
    liveAnchor('live-1', 'C:/p/1', 'b1');
    db.insertProjectSession({
      id: 'dormant-1',
      project_slug: 'd1',
      cwd: 'C:/p/2',
      title: 'd1',
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
    const tiles = listProjectAnchorTiles(db, { ...stubs, status: 'all' });
    expect(tiles.map((t) => t.anchor_id).sort()).toEqual([
      'dormant-1',
      'live-1',
    ]);
    /* Dormant tiles still carry a resolvable supervision_mode so the
     * toggle can render + PATCH against them. */
    const dormant = tiles.find((t) => t.anchor_id === 'dormant-1');
    expect(['polling', 'event', 'off']).toContain(dormant!.supervision_mode);
  });

  it('decodes connection count from current_bridge_id marker', () => {
    liveAnchor('a1', 'C:/p/1', 'bridge-x|4');
    const [tile] = listProjectAnchorTiles(db, stubs);
    expect(tile!.bridge_connection_count).toBe(4);
    expect(tile!.current_bridge_id).toBe('bridge-x');
  });

  it('reports bridge_connection_count=1 for single-bridge markers', () => {
    liveAnchor('a1', 'C:/p/1', 'bridge-y');
    const [tile] = listProjectAnchorTiles(db, stubs);
    expect(tile!.bridge_connection_count).toBe(1);
  });

  it('sorts tiles by last_activity_ms desc', () => {
    /* Last activity is derived from transcript_ref closed/opened
     * timestamps, falling back to last_seen_ms when no refs exist. */
    db.insertProjectSession({
      id: 'old',
      project_slug: 'old',
      cwd: 'C:/p/old',
      title: 'old',
      status: 'live',
      current_session_id: null,
      current_bridge_id: 'b-old',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 100,
    });
    db.insertProjectSession({
      id: 'new',
      project_slug: 'new',
      cwd: 'C:/p/new',
      title: 'new',
      status: 'live',
      current_session_id: null,
      current_bridge_id: 'b-new',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 9999,
    });
    const tiles = listProjectAnchorTiles(db, stubs);
    expect(tiles.map((t) => t.anchor_id)).toEqual(['new', 'old']);
  });

  it('emits exactly one tile per anchor even when many transcript_refs exist', () => {
    liveAnchor('a1', 'C:/p/1', 'b1|3');
    db.insertProjectTranscriptRef({
      id: 'r1',
      anchor_id: 'a1',
      cc_session_id: 'cc-1',
      jsonl_path: 'X:/1.jsonl',
      opened_ms: 1,
      closed_ms: 5,
    });
    db.insertProjectTranscriptRef({
      id: 'r2',
      anchor_id: 'a1',
      cc_session_id: 'cc-2',
      jsonl_path: 'X:/2.jsonl',
      opened_ms: 10,
      closed_ms: null,
    });
    db.insertProjectTranscriptRef({
      id: 'r3',
      anchor_id: 'a1',
      cc_session_id: 'cc-3',
      jsonl_path: 'X:/3.jsonl',
      opened_ms: 20,
      closed_ms: 25,
    });
    const tiles = listProjectAnchorTiles(db, stubs);
    expect(tiles.length).toBe(1);
    const [t] = tiles;
    expect(t!.transcript_count).toBe(3);
    /* Most recent transcript = the one with the latest opened_ms. */
    expect(t!.transcript_path).toBe('X:/3.jsonl');
    expect(t!.last_activity_ms).toBe(25);
    expect(t!.bridge_connection_count).toBe(3);
  });
});

describe('buildProjectAnchorTile', () => {
  it('uses pendingResolver=permission to override phase', () => {
    liveAnchor('a1', 'C:/p/1', 'b1');
    db.insertProjectTranscriptRef({
      id: 'r1',
      anchor_id: 'a1',
      cc_session_id: 'cc-x',
      jsonl_path: 'X:/1.jsonl',
      opened_ms: 1,
      closed_ms: null,
    });
    const row = db.getProjectSession('a1')!;
    const tile = buildProjectAnchorTile(db, row, {
      phaseResolver: () => 'thinking',
      tailPhaseResolver: noTail,
      pendingResolver: () => ({
        prompt_id: 'p1',
        text: 'hi',
        queued_ms: 1,
      } as never),
    });
    expect(tile.phase).toBe('permission');
    expect(tile.pending_prompt).not.toBeNull();
  });

  it('tail-phase override beats explicit phaseResolver when tail is non-unknown', () => {
    liveAnchor('a1', 'C:/p/1', 'b1');
    db.insertProjectTranscriptRef({
      id: 'r1',
      anchor_id: 'a1',
      cc_session_id: 'cc-x',
      jsonl_path: 'X:/1.jsonl',
      opened_ms: 1,
      closed_ms: null,
    });
    const row = db.getProjectSession('a1')!;
    const tile = buildProjectAnchorTile(db, row, {
      phaseResolver: () => 'thinking',
      tailPhaseResolver: () => 'tool',
      pendingResolver: noPending,
    });
    expect(tile.phase).toBe('tool');
  });

  it('falls back to last_seen_ms when no transcript_refs exist', () => {
    db.insertProjectSession({
      id: 'no-refs',
      project_slug: 'no-refs',
      cwd: 'C:/p/x',
      title: 'no-refs',
      status: 'live',
      current_session_id: null,
      current_bridge_id: 'b',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 4242,
    });
    const row = db.getProjectSession('no-refs')!;
    const tile = buildProjectAnchorTile(db, row, stubs);
    expect(tile.transcript_count).toBe(0);
    expect(tile.last_activity_ms).toBe(4242);
    expect(tile.phase).toBe('unknown');
  });
});
