/* Integration coverage for POST /brainstorms/standalone kind wiring
 * (meeting-notes fixes 2026-07, task 1 / F1). This is the direct-llm
 * creation route the notes-mode "meeting session" toggle's hello-kind
 * ultimately keys off (see the WS hello handler's applyHelloKind,
 * which uses the same setKind/setBrainstormPhaseTwo write path
 * covered directly by brainstorm-kind-classification.test.ts). Here
 * we pin the HTTP contract: kind='meeting' in the body lands a
 * meeting row and it shows up under /meetings; anything else (including
 * the default off-mode path with no kind at all) leaves the row a
 * plain brainstorm and it does NOT show up under /meetings.
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-standalone-kind-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  setBrainstormStore({ db });
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

interface StandaloneResponse {
  ok: boolean;
  brainstorm: { brainstorm: { id: string; kind?: string } };
}

describe('POST /brainstorms/standalone kind wiring', () => {
  it("kind='meeting' lands a meeting row that /meetings then lists", async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/brainstorms/standalone',
      payload: { mode: 'notes', kind: 'meeting' },
    });
    expect(create.statusCode).toBe(200);
    const body = create.json() as StandaloneResponse;
    expect(body.ok).toBe(true);
    const id = body.brainstorm.brainstorm.id;
    expect(db.getBrainstorm(id)?.kind).toBe('meeting');

    /* A fresh standalone row has turn_count=0 and no audio/distilled_at,
     * so GET /meetings' default zero-substance filter (the same orphan
     * filter GET /brainstorms applies) hides it until it has real
     * content -- unlike /brainstorms, /meetings does not accept
     * ?include_empty=1 to bypass that filter. Simulate a turn landing
     * (the normal path once a real conversation starts) so this test
     * isolates the kind filter specifically, not the substance filter. */
    db.updateBrainstorm(id, { turn_count: 1 });
    const list = await app.inject({ method: 'GET', url: '/meetings' });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { ok: boolean; meetings: Array<{ id: string }> };
    expect(listBody.meetings.map((m) => m.id)).toContain(id);
  });

  it('default off-mode path (kind omitted) is unaffected: brainstorm row, absent from /meetings', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/brainstorms/standalone',
      payload: { mode: 'conversation' },
    });
    expect(create.statusCode).toBe(200);
    const body = create.json() as StandaloneResponse;
    const id = body.brainstorm.brainstorm.id;
    expect(db.getBrainstorm(id)?.kind ?? 'brainstorm').toBe('brainstorm');

    const list = await app.inject({ method: 'GET', url: '/meetings' });
    const listBody = list.json() as { ok: boolean; meetings: Array<{ id: string }> };
    expect(listBody.meetings.map((m) => m.id)).not.toContain(id);
  });

  it("notes mode without an explicit kind='meeting' body field does NOT auto-flip to meeting", async () => {
    /* CODEX-REVIEW-002.md:71: explicit confirm, never inferred from
     * mode alone. */
    const create = await app.inject({
      method: 'POST',
      url: '/brainstorms/standalone',
      payload: { mode: 'notes' },
    });
    const body = create.json() as StandaloneResponse;
    const id = body.brainstorm.brainstorm.id;
    expect(db.getBrainstorm(id)?.kind ?? 'brainstorm').toBe('brainstorm');
  });

  it("any kind value other than the literal 'meeting' is treated as brainstorm", async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/brainstorms/standalone',
      payload: { mode: 'notes', kind: 'something-else' },
    });
    const body = create.json() as StandaloneResponse;
    const id = body.brainstorm.brainstorm.id;
    expect(db.getBrainstorm(id)?.kind ?? 'brainstorm').toBe('brainstorm');
  });
});
