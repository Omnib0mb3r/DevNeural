/**
 * Phase C routes (2026-09-22): handover request, review with a visible
 * two-half file, browsing scoped to the brainstorm, the one auto-clear
 * switch, and the approval registry that serves the reseed once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  AUTO_CLEAR_MODE_KEY,
  HANDOVER_REQUEST_PROMPT,
  autoClearMode,
  registerHandoverRoutes,
} from '../src/dashboard/handover-routes.js';
import { HandoverApprovalRegistry } from '../src/lex/handover-approval.js';
import { SMART_CLEAR_MODE_KEY } from '../src/lex/smart-clear.js';
import { SMART_COMPACT_CONFIG_KEY } from '../src/dashboard/smart-compact-routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let priorDataRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-handover-routes-'));
  priorDataRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const dbFile = path.join(tmpDir, 'index.db');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } }).db
    .prepare('DELETE FROM project_session')
    .run();
  db.insertProjectSession({
    id: 'proj-a',
    project_slug: 'proj-a',
    cwd: 'C:/p/proj-a',
    title: 'proj-a',
    status: 'live',
    current_session_id: 'cc-worker-a',
    current_bridge_id: 'b-a',
    current_pty_id: 'pty-a',
    created_ms: 1,
    last_seen_ms: 1,
  });
});

afterEach(() => {
  db.close();
  if (priorDataRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorDataRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function build(over: { now?: () => number; voice?: boolean } = {}) {
  const app = Fastify({ logger: false });
  const requests: Array<{ targetSession: string; brainstormId: string; text: string }> = [];
  const reviewed: string[] = [];
  const registry = new HandoverApprovalRegistry(over.now);
  const rootDir = path.join(tmpDir, 'brainstorms').replace(/\\/g, '/');
  registerHandoverRoutes(app, db, () => undefined, {
    registry,
    requestWorkerHandover: async (i) => {
      requests.push({ targetSession: i.targetSession, brainstormId: i.brainstormId, text: i.text });
      return { ok: true, status: 200, decision: 'accepted' };
    },
    onReviewed: async (p) => {
      reviewed.push(p.handoverId);
      return over.voice === true;
    },
    fs: { rootDir },
    ...(over.now ? { now: over.now } : {}),
  });
  return { app, requests, reviewed, registry, rootDir };
}

const DRAFT = {
  verified_state: 'HEAD abc1234 on voice-layers, tree clean.',
  what_i_was_doing: 'Task 6 routes, end of step 3.',
  decisions_in_force: 'No Anthropic API.',
  stopping_point: 'Committed, nothing dirty.',
};
const LEX = {
  session_id: 'cc-lex',
  corrections: ['Step 3 is the review route, not the request route.'],
  next_steps: 'Task 7 next, then 8.',
  plan_reference: 'plans/2026-09-22-voice-and-clear-complete.md',
  verdict: 'revised',
};

describe('handover routes', () => {
  it('handover-request injects the T5 wrap prompt into the worker session', async () => {
    const { app, requests } = build();
    const r = await app.inject({
      method: 'POST',
      url: '/lex/smart-clear/handover-request',
      payload: { brainstorm_id: 'bs-1', anchor_id: 'proj-a' },
    });
    expect(r.statusCode).toBe(200);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.targetSession).toBe('cc-worker-a');
    expect(requests[0]!.text).toBe(HANDOVER_REQUEST_PROMPT);
    for (const h of ['### Verified state', '### What I was doing', '### Decisions in force', '### Stopping point']) {
      expect(requests[0]!.text).toContain(h);
    }
    const missing = await app.inject({
      method: 'POST',
      url: '/lex/smart-clear/handover-request',
      payload: { brainstorm_id: 'bs-1', anchor_id: 'nope' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('review answers held_for_approval when a voice client took the handover', async () => {
    const { app, registry } = build({ voice: true });
    const r = await app.inject({
      method: 'POST',
      url: '/lex/smart-clear/review',
      payload: { brainstorm_id: 'bs-1', anchor_id: 'proj-a', worker_draft: DRAFT, lex: LEX },
    });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { decision: string }).decision).toBe('held_for_approval');
    /* Lex driving the clear herself by handover id marks it approved so
     * the worker's clear-handoff hook serves this frame once. */
    const id = (r.json() as { handover_id: string }).handover_id;
    expect(registry.approveById(id)?.approvedAtMs).not.toBeNull();
    expect(registry.consumeApproved('proj-a')?.handoverId).toBe(id);
    expect(registry.consumeApproved('proj-a')).toBeNull();
  });

  it('review persists both halves, registers the approval, lists it for that brainstorm only', async () => {
    const { app, reviewed, registry, rootDir } = build();
    const r = await app.inject({
      method: 'POST',
      url: '/lex/smart-clear/review',
      payload: { brainstorm_id: 'bs-1', anchor_id: 'proj-a', worker_draft: DRAFT, lex: LEX },
    });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { ok: boolean; handover_id: string; reseed: string; gist: string; vet: { ok: boolean } };
    expect(j.ok).toBe(true);
    expect(j.vet.ok).toBe(true);
    expect(j.handover_id).toMatch(/^HANDOVER-.*\.md$/);
    expect(j.reseed).toMatch(/^Next steps: Task 7 next/m);
    expect(j.gist).toMatch(/The worker is at: Task 6 routes/);
    const onDisk = fs.readFileSync(path.join(rootDir, 'bs-1', j.handover_id), 'utf-8');
    expect(onDisk).toMatch(/^## Worker draft \(worker session cc-worker-a,/m);
    expect(onDisk).toMatch(/^## Lex review \(revised, session cc-lex,/m);
    expect(onDisk).toMatch(/^- Step 3 is the review route/m);
    expect(reviewed).toEqual([j.handover_id]);
    expect(registry.pendingForBrainstorm('bs-1')?.handoverId).toBe(j.handover_id);
    /* The test hook resolves void: nobody is listening by voice. */
    expect((r.json() as { decision: string }).decision).toBe('no_voice');

    const list = await app.inject({ method: 'GET', url: '/lex/anchors/bs-1/handovers' });
    const lj = list.json() as { handovers: Array<{ file: string; verdict: string | null; unvetted: boolean }> };
    expect(lj.handovers).toHaveLength(1);
    expect(lj.handovers[0]).toMatchObject({ file: j.handover_id, verdict: 'revised', unvetted: false });
    const other = await app.inject({ method: 'GET', url: '/lex/anchors/bs-2/handovers' });
    expect((other.json() as { handovers: unknown[] }).handovers).toEqual([]);
    const one = await app.inject({ method: 'GET', url: `/lex/anchors/bs-1/handovers/${j.handover_id}` });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { frame: { lex: { verdict: string } } }).frame.lex.verdict).toBe('revised');
    const bad = await app.inject({ method: 'GET', url: '/lex/anchors/bs-1/handovers/notes.md' });
    expect(bad.statusCode).toBe(404);
  });

  it('review refuses a frame that fails the structural vet unless forced', async () => {
    const { app } = build();
    const r = await app.inject({
      method: 'POST',
      url: '/lex/smart-clear/review',
      payload: {
        brainstorm_id: 'bs-1',
        anchor_id: 'proj-a',
        worker_draft: { ...DRAFT, verified_state: '', stopping_point: '' },
        lex: LEX,
      },
    });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { vet: { issues: string[] } }).vet.issues).toContain('verified state is empty');
  });

  it('the one auto-clear switch writes all three keys and reads back', async () => {
    const { app } = build();
    expect(autoClearMode(db)).toBe('shadow');
    const r = await app.inject({ method: 'POST', url: '/lex/auto-clear/mode', payload: { mode: 'live' } });
    expect(r.statusCode).toBe(200);
    expect(db.getRuntimeConfig(AUTO_CLEAR_MODE_KEY)).toBe('live');
    expect(db.getRuntimeConfig(SMART_CLEAR_MODE_KEY)).toBe('live');
    expect(db.getRuntimeConfig(SMART_COMPACT_CONFIG_KEY)).toBe('live');
    const g = await app.inject({ method: 'GET', url: '/lex/auto-clear/mode' });
    expect((g.json() as { mode: string }).mode).toBe('live');
    const bad = await app.inject({ method: 'POST', url: '/lex/auto-clear/mode', payload: { mode: 'sometimes' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('HandoverApprovalRegistry', () => {
  it('approve then consume exactly once; a newer review replaces an unapproved one; expiry', () => {
    let t = 1_000;
    const reg = new HandoverApprovalRegistry(() => t);
    const base = { file: 'f', brainstormId: 'bs-1', projectAnchorId: 'proj-a', reseed: 'seed', gist: 'g' };
    reg.register({ ...base, handoverId: 'h1' });
    reg.register({ ...base, handoverId: 'h2' });
    expect(reg.get('h1')).toBeNull();
    expect(reg.pendingForBrainstorm('bs-1')?.handoverId).toBe('h2');
    expect(reg.consumeApproved('proj-a')).toBeNull();
    expect(reg.approve('bs-1')?.handoverId).toBe('h2');
    expect(reg.pendingForBrainstorm('bs-1')).toBeNull();
    expect(reg.consumeApproved('proj-a')?.reseed).toBe('seed');
    expect(reg.consumeApproved('proj-a')).toBeNull();
    reg.register({ ...base, handoverId: 'h3' });
    expect(reg.reject('bs-1')?.handoverId).toBe('h3');
    reg.register({ ...base, handoverId: 'h4' });
    /* A new review replaces the rejected one outright. */
    expect(reg.get('h3')).toBeNull();
    t += 16 * 60_000;
    expect(reg.pendingForBrainstorm('bs-1')).toBeNull();
    expect(reg.expireNow().map((p) => p.handoverId).sort()).toEqual(['h2', 'h4']);
  });
});
