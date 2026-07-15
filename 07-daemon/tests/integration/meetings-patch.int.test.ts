/* Integration coverage for PATCH /meetings/:id (meeting-notes fixes
 * 2026-07, task 4 / F4). attendees + meeting_topic had columns and no
 * write endpoint; this pins validation (string or null; anything
 * else 400) and the actual row update + 404 on a non-meeting id.
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

const MEETING_ID = 'meeting-patch-test';
const BRAINSTORM_ID = 'brainstorm-not-a-meeting';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-meeting-patch-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  setBrainstormStore({ db });

  db.insertBrainstorm({
    id: MEETING_ID,
    claude_session_id: null,
    pty_id: null,
    cwd: tmpDir,
    user_label: 'weekly sync',
    derived_label: null,
    mode: 'notes',
    status: 'ended',
    started_ms: Date.now() - 60_000,
    ended_ms: Date.now(),
    turn_count: 2,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
  db.setBrainstormPhaseTwo(MEETING_ID, { kind: 'meeting' });

  db.insertBrainstorm({
    id: BRAINSTORM_ID,
    claude_session_id: null,
    pty_id: null,
    cwd: tmpDir,
    user_label: null,
    derived_label: null,
    mode: 'conversation',
    status: 'ended',
    started_ms: Date.now() - 60_000,
    ended_ms: Date.now(),
    turn_count: 1,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });

  /* registerDashboardRoutes runs the boot reaper (reapAllActive),
   * which hard-deletes any ENDED row with a null claude_session_id
   * AND zero brainstorm_chunks rows (pre-bind-orphan cleanup, see
   * lex/brainstorm-store.ts's reapAllActive doc comment). turn_count
   * alone does not save a row from that sweep -- it counts actual
   * chunk rows. Seed one real chunk per row so both seeds survive
   * the reaper the same way a real session with a transcript would. */
  db.insertBrainstormChunk({
    id: `${MEETING_ID}-chunk-0`,
    brainstorm_id: MEETING_ID,
    turn_index: 0,
    role: 'user',
    mode: 'notes',
    text: 'seed turn for reaper survival',
    model_id: '',
  });
  db.insertBrainstormChunk({
    id: `${BRAINSTORM_ID}-chunk-0`,
    brainstorm_id: BRAINSTORM_ID,
    turn_index: 0,
    role: 'user',
    mode: 'conversation',
    text: 'seed turn for reaper survival',
    model_id: '',
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

describe('PATCH /meetings/:id', () => {
  it('updates attendees and meeting_topic and returns the updated row', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${encodeURIComponent(MEETING_ID)}`,
      payload: { attendees: 'alice, bob', meeting_topic: 'roadmap review' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      meeting: { attendees: string | null; meeting_topic: string | null };
    };
    expect(body.ok).toBe(true);
    expect(body.meeting.attendees).toBe('alice, bob');
    expect(body.meeting.meeting_topic).toBe('roadmap review');

    /* Row actually persisted, not just echoed. */
    expect(db.getBrainstorm(MEETING_ID)?.attendees).toBe('alice, bob');
    expect(db.getBrainstorm(MEETING_ID)?.meeting_topic).toBe('roadmap review');
  });

  it('trims whitespace on both fields', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${encodeURIComponent(MEETING_ID)}`,
      payload: { attendees: '  carol  ', meeting_topic: '  q3 planning  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(db.getBrainstorm(MEETING_ID)?.attendees).toBe('carol');
    expect(db.getBrainstorm(MEETING_ID)?.meeting_topic).toBe('q3 planning');
  });

  it('null clears a field; omitted leaves it unchanged', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/meetings/${encodeURIComponent(MEETING_ID)}`,
      payload: { attendees: 'dave', meeting_topic: 'kickoff' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${encodeURIComponent(MEETING_ID)}`,
      payload: { attendees: null },
    });
    expect(res.statusCode).toBe(200);
    expect(db.getBrainstorm(MEETING_ID)?.attendees).toBeNull();
    /* meeting_topic was omitted from the second PATCH; stays as-is. */
    expect(db.getBrainstorm(MEETING_ID)?.meeting_topic).toBe('kickoff');
  });

  it('rejects a non-string, non-null attendees value with 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${encodeURIComponent(MEETING_ID)}`,
      payload: { attendees: 42 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/attendees must be a string or null/);
  });

  it('rejects a non-string, non-null meeting_topic value with 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${encodeURIComponent(MEETING_ID)}`,
      payload: { meeting_topic: ['not', 'a', 'string'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty body with 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${encodeURIComponent(MEETING_ID)}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s for an unknown id', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/meetings/does-not-exist',
      payload: { attendees: 'alice' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s for a brainstorm-kind id (not a meeting)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${encodeURIComponent(BRAINSTORM_ID)}`,
      payload: { attendees: 'alice' },
    });
    expect(res.statusCode).toBe(404);
  });
});
