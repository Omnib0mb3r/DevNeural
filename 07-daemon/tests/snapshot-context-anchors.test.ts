/**
 * buildVoiceSnapshot open_projects block sourced from project_session
 * (PROJECT-ANCHORS.md step 5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore as setBrainstormStore } from '../src/lex/brainstorm-store.js';
import { buildVoiceSnapshot } from '../src/lex/snapshot-context.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-snapshot-'));
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
  setBrainstormStore({ db } as never);
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

describe('buildVoiceSnapshot open_projects', () => {
  it('renders live anchors with anchor + session + bridge fields', () => {
    db.insertProjectSession({
      id: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
      project_slug: 'DevNeural',
      cwd: 'C:/dev/Projects/DevNeural',
      title: 'DevNeural',
      status: 'live',
      current_session_id: 'd8daa427-cccc-dddd-eeee-ffffffffffff',
      current_bridge_id: 'bridge-1',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 100,
    });
    const snap = buildVoiceSnapshot();
    expect(snap).toContain('<live_state');
    expect(snap).toContain('open_projects');
    expect(snap).toContain('DevNeural');
    /* anchor + session short ids and bridge=ok marker */
    expect(snap).toContain('anchor aaaaaaaa');
    expect(snap).toContain('session d8daa427');
    expect(snap).toContain('status=live');
    expect(snap).toContain('bridge=ok');
  });

  it('reports bridge=N when multiple windows share an anchor', () => {
    db.insertProjectSession({
      id: 'anchor-multi',
      project_slug: 'multi',
      cwd: 'C:/dev/Projects/multi',
      title: 'multi',
      status: 'live',
      current_session_id: 'cc-12345678',
      current_bridge_id: 'bridge-1|3',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 100,
    });
    const snap = buildVoiceSnapshot();
    expect(snap).toContain('bridge=3');
    expect(snap).not.toContain('bridge=ok\n');
  });

  it('reports session=none when an anchor is live but has not yet bound a CC session', () => {
    db.insertProjectSession({
      id: 'no-cc',
      project_slug: 'no-cc',
      cwd: 'C:/dev/Projects/no-cc',
      title: 'no-cc',
      status: 'live',
      current_session_id: null,
      current_bridge_id: 'bridge-1',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 100,
    });
    const snap = buildVoiceSnapshot();
    expect(snap).toContain('session none');
  });

  it('emits (none) when no live anchors exist', () => {
    db.insertProjectSession({
      id: 'dormant-only',
      project_slug: 'dormant',
      cwd: 'C:/dev/Projects/dormant',
      title: 'dormant',
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
    const snap = buildVoiceSnapshot();
    expect(snap).toContain('open_projects');
    expect(snap).toContain('(none)');
  });

  it('skips dormant anchors from the open_projects list', () => {
    db.insertProjectSession({
      id: 'live-1',
      project_slug: 'aaa',
      cwd: 'C:/dev/Projects/aaa',
      title: 'aaa',
      status: 'live',
      current_session_id: 'cc-1',
      current_bridge_id: 'b1',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 100,
    });
    db.insertProjectSession({
      id: 'dormant-1',
      project_slug: 'bbb',
      cwd: 'C:/dev/Projects/bbb',
      title: 'bbb',
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
    const snap = buildVoiceSnapshot();
    expect(snap).toContain('aaa');
    expect(snap).not.toContain('- bbb (');
  });
});
