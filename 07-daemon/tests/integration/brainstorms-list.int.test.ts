/* Integration coverage for the /brainstorms route's empty-row filter
 * (bug: 2026-05-11-past-sessions-orphan-pollution). Seeds two rows,
 * one substantive and one orphan (turn_count=0, no audio, no
 * distilled_at), hits GET /brainstorms via fastify.inject, and asserts
 * only the substantive row returns. ?include_empty=1 surfaces both.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-bsroute-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  db = new IndexDb(dbFile);
  db.close();
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

function seedBrainstorm(opts: {
  id: string;
  startedMsOffset: number;
  turnCount: number;
}): void {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: tmpDir,
    user_label: null,
    derived_label: null,
    mode: 'conversation',
    status: 'ended',
    started_ms: Date.now() + opts.startedMsOffset,
    ended_ms: Date.now(),
    turn_count: opts.turnCount,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
}

describe('GET /brainstorms empty-row filter', () => {
  it('hides zero-substance orphan rows by default', async () => {
    seedBrainstorm({ id: 'orphan', startedMsOffset: -1000, turnCount: 0 });
    seedBrainstorm({ id: 'real', startedMsOffset: -500, turnCount: 3 });
    const res = await app.inject({ method: 'GET', url: '/brainstorms' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      brainstorms: Array<{ brainstorm: { id: string } }>;
    };
    expect(body.ok).toBe(true);
    const ids = body.brainstorms.map((b) => b.brainstorm.id);
    expect(ids).toContain('real');
    expect(ids).not.toContain('orphan');
  });

  it('surfaces orphan rows when ?include_empty=1', async () => {
    seedBrainstorm({ id: 'orphan', startedMsOffset: -1000, turnCount: 0 });
    seedBrainstorm({ id: 'real', startedMsOffset: -500, turnCount: 3 });
    const res = await app.inject({
      method: 'GET',
      url: '/brainstorms?include_empty=1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      brainstorms: Array<{ brainstorm: { id: string } }>;
    };
    const ids = body.brainstorms.map((b) => b.brainstorm.id);
    expect(ids).toContain('real');
    expect(ids).toContain('orphan');
  });
});
