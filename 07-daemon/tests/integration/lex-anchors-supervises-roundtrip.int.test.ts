/* Integration coverage for the supervises_project_anchor_id field
 * round-trip through fastify (regression for the 2026-05-13 tile-
 * picker bounce bug).
 *
 * The SupervisesPicker bound to a brainstorm tile let the operator
 * pick a project, the PATCH succeeded, but the next refetch tick
 * dropped the selection back to '(no project)'. Root cause was the
 * response mappers in GET /lex/anchors and GET /lex/anchors/:id
 * omitting the column even though the DB row carried it. This test
 * pins that the field round-trips through both endpoints after a
 * PATCH, so the controlled <select> can stay latched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { IndexDb } from '../../src/store/index-db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { registerDashboardRoutes } from '../../src/dashboard/routes.js';
import { setStore as setBrainstormStore } from '../../src/lex/brainstorm-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;
let app: ReturnType<typeof Fastify>;

const LEX_ID = 'lex-supervises-roundtrip';
const PROJ_ID = 'proj-supervises-roundtrip';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-lex-anchor-rt-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  /* Pre-create the IndexDb so its inline migrate runs once, then
   * run the versioned runner so 025 (supervises column) lands. */
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  setBrainstormStore({ db });
  /* Seed the project anchor the PATCH validator looks up. */
  db.insertProjectSession({
    id: PROJ_ID,
    project_slug: 'roundtrip',
    cwd: path.join(tmpDir, 'Projects', 'roundtrip').replace(/\\/g, '/'),
    title: 'Roundtrip',
    status: 'live',
    current_session_id: 'cc-roundtrip-live',
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1,
    last_seen_ms: 1,
  });
  /* Seed a dormant lex_session unbound — supervises starts null. */
  db.insertLexSession({
    id: LEX_ID,
    created_ms: 1,
    title: 'tile-picker bug',
    derived_title: null,
    status: 'dormant',
    current_pty_id: null,
    cwd: path.join(tmpDir, 'home').replace(/\\/g, '/'),
    supervises_project_anchor_id: null,
  });
  app = Fastify({ logger: false });
  await registerDashboardRoutes(app, { db } as never, () => undefined);
});

afterEach(async () => {
  await app.close();
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('supervises_project_anchor_id round-trips through /lex/anchors GETs', () => {
  it('null on a fresh row, then echoes through both endpoints after PATCH', async () => {
    /* Baseline: brand-new row has no binding. Both endpoints must
     * include the column with value null, NOT omit it (the dashboard
     * reads row.supervises_project_anchor_id ?? null and uses the
     * value to seed a controlled <select>; an undefined field bounced
     * the picker back to '(no project)' on every refetch). */
    const listBefore = await app.inject({
      method: 'GET',
      url: '/lex/anchors',
    });
    expect(listBefore.statusCode).toBe(200);
    const listBody = listBefore.json() as {
      ok: boolean;
      anchors: Array<{
        id: string;
        supervises_project_anchor_id: string | null;
      }>;
    };
    const beforeRow = listBody.anchors.find((a) => a.id === LEX_ID);
    expect(beforeRow).toBeTruthy();
    expect(beforeRow).toHaveProperty('supervises_project_anchor_id');
    expect(beforeRow!.supervises_project_anchor_id).toBeNull();

    const detailBefore = await app.inject({
      method: 'GET',
      url: `/lex/anchors/${encodeURIComponent(LEX_ID)}`,
    });
    expect(detailBefore.statusCode).toBe(200);
    const detailBody = detailBefore.json() as {
      ok: boolean;
      anchor: {
        id: string;
        supervises_project_anchor_id: string | null;
      };
    };
    expect(detailBody.anchor).toHaveProperty('supervises_project_anchor_id');
    expect(detailBody.anchor.supervises_project_anchor_id).toBeNull();

    /* Bind via PATCH the same way the dashboard mutation does. */
    const patch = await app.inject({
      method: 'PATCH',
      url: `/lex/anchors/${encodeURIComponent(LEX_ID)}`,
      payload: { supervises_project_anchor_id: PROJ_ID },
    });
    expect(patch.statusCode).toBe(200);

    /* List endpoint now echoes the bound id. */
    const listAfter = await app.inject({
      method: 'GET',
      url: '/lex/anchors',
    });
    const listBodyAfter = listAfter.json() as {
      ok: boolean;
      anchors: Array<{
        id: string;
        supervises_project_anchor_id: string | null;
      }>;
    };
    const afterRow = listBodyAfter.anchors.find((a) => a.id === LEX_ID);
    expect(afterRow).toBeTruthy();
    expect(afterRow!.supervises_project_anchor_id).toBe(PROJ_ID);

    /* Detail endpoint echoes too. */
    const detailAfter = await app.inject({
      method: 'GET',
      url: `/lex/anchors/${encodeURIComponent(LEX_ID)}`,
    });
    const detailBodyAfter = detailAfter.json() as {
      ok: boolean;
      anchor: {
        id: string;
        supervises_project_anchor_id: string | null;
      };
    };
    expect(detailBodyAfter.anchor.supervises_project_anchor_id).toBe(PROJ_ID);
  });

  it('clearing the binding via PATCH supervises=null round-trips as null in both endpoints', async () => {
    /* Set up: bind first so the clear path exercises the
     * not-null -> null transition. */
    db.setLexSessionSupervises(LEX_ID, PROJ_ID);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/lex/anchors/${encodeURIComponent(LEX_ID)}`,
      payload: { supervises_project_anchor_id: null },
    });
    expect(patch.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/lex/anchors' });
    const listBody = list.json() as {
      anchors: Array<{
        id: string;
        supervises_project_anchor_id: string | null;
      }>;
    };
    const row = listBody.anchors.find((a) => a.id === LEX_ID);
    expect(row).toBeTruthy();
    expect(row!.supervises_project_anchor_id).toBeNull();

    const detail = await app.inject({
      method: 'GET',
      url: `/lex/anchors/${encodeURIComponent(LEX_ID)}`,
    });
    const detailBody = detail.json() as {
      anchor: {
        id: string;
        supervises_project_anchor_id: string | null;
      };
    };
    expect(detailBody.anchor.supervises_project_anchor_id).toBeNull();
  });
});
