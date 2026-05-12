/**
 * listSessions liveness is now anchor-backed
 * (PROJECT-ANCHORS.md step 6).
 *
 * The StreamDeck.App identity-file path is no longer authoritative;
 * a CC session_id surfaces as active in listSessions only when some
 * live project_session has it as current_session_id.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore as setBrainstormStore } from '../src/lex/brainstorm-store.js';
import { listSessions, readIdentityFileWindowMap } from '../src/dashboard/sessions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let homeDir: string;
let claudeRoot: string;
let priorRoot: string | undefined;
let priorProjectsRoot: string | undefined;
let priorUserprofile: string | undefined;
let priorHome: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-sessions-anchor-'));
  dbFile = path.join(tmpDir, 'index.db');
  homeDir = path.join(tmpDir, 'home');
  claudeRoot = path.join(homeDir, '.claude', 'projects');
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });

  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  priorProjectsRoot = process.env.DEVNEURAL_PROJECTS_ROOT;
  priorUserprofile = process.env.USERPROFILE;
  priorHome = process.env.HOME;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path
    .join(tmpDir, 'Projects')
    .replace(/\\/g, '/');
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;

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

function writeJsonl(slug: string, sessionId: string, cwd: string): string {
  const slugDir = path.join(claudeRoot, slug);
  fs.mkdirSync(slugDir, { recursive: true });
  const file = path.join(slugDir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'summary',
      cwd,
      sessionId,
      timestamp: new Date().toISOString(),
    }) + '\n',
    'utf-8',
  );
  return file;
}

describe('listSessions anchor-backed liveness', () => {
  /* NOTE: snapshot-context.ts cached the listSessions/STREAMDECK
   * constants at module load time on its own dependency graph. These
   * tests exercise listSessions directly because it always reads
   * fresh state. */
  it('surfaces a session whose CC UUID matches a live anchor.current_session_id', () => {
    const cwd = 'C:/dev/Projects/foo';
    const ccId = 'aaaaaaaa-1111-1111-1111-111111111111';
    writeJsonl('c--dev-Projects-foo', ccId, cwd);
    db.insertProjectSession({
      id: 'anchor-foo',
      project_slug: 'foo',
      cwd,
      title: 'foo',
      status: 'live',
      current_session_id: ccId,
      current_bridge_id: 'b-1',
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 100,
    });
    const sessions = listSessions();
    expect(sessions.map((s) => s.session_id)).toContain(ccId);
  });

  it('omits sessions whose CC UUID is not bound to any live anchor', () => {
    const cwd = 'C:/dev/Projects/orphan';
    const ccId = 'bbbbbbbb-2222-2222-2222-222222222222';
    writeJsonl('c--dev-Projects-orphan', ccId, cwd);
    /* No anchor inserted for this jsonl. */
    const sessions = listSessions();
    expect(sessions.map((s) => s.session_id)).not.toContain(ccId);
  });

  it('omits sessions whose anchor is dormant even if the jsonl exists', () => {
    const cwd = 'C:/dev/Projects/dormie';
    const ccId = 'cccccccc-3333-3333-3333-333333333333';
    writeJsonl('c--dev-Projects-dormie', ccId, cwd);
    db.insertProjectSession({
      id: 'anchor-dormie',
      project_slug: 'dormie',
      cwd,
      title: 'dormie',
      status: 'dormant',
      current_session_id: ccId,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 1,
      last_seen_ms: 1,
    });
    const sessions = listSessions();
    expect(sessions.map((s) => s.session_id)).not.toContain(ccId);
  });
});

describe('readIdentityFileWindowMap (editor-detection retained)', () => {
  it('returns an empty map when the identity directory is missing', () => {
    /* Without LOCALAPPDATA pointing at a populated stream-deck/
     * identity dir, the helper returns an empty map. The function
     * exists exclusively for the focus-tile-click flow; liveness no
     * longer depends on it. */
    const map = readIdentityFileWindowMap();
    expect(map.size).toBe(0);
  });
});
