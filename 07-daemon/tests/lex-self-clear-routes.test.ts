/**
 * Lex self-clear routes (T4): the three checks land in the file, a NO is
 * a 422, a worker clear in flight is a 409, an approved handover types
 * /clear, kicks the fresh session, and the handoff is served once to the
 * brainstorm cwd only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { registerLexSelfClearRoutes, type LexSelfClearDeps } from '../src/dashboard/lex-self-clear-routes.js';
import { SelfClearGate } from '../src/lex/lex-self-clear.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');
const BRAINSTORM_CWD = 'C:/data/brainstorm';

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-self-clear-'));
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
  db.insertLexSession({
    id: 'bs-1',
    created_ms: 1,
    title: null,
    derived_title: null,
    status: 'live',
    current_pty_id: 'pty-lex',
    cwd: BRAINSTORM_CWD,
    supervises_project_anchor_id: 'proj-a',
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const DRAFT = {
  verified_state: 'The worker is at HEAD abc1234 on voice-layers, tree clean.',
  what_i_was_doing: 'Supervising the worker through Task 9.',
  decisions_in_force: 'No Anthropic API.',
  stopping_point: 'Worker committed Task 8.',
};
const BODY = {
  brainstorm_id: 'bs-1',
  draft: DRAFT,
  next_steps: 'Watch the worker finish Task 9, then Task 12.',
  plan_reference: 'docs/plan.md, Task 9',
};

function build(over: { judge?: string | null; inFlight?: boolean; transcripts?: string[] } = {}) {
  const app = Fastify({ logger: false });
  let now = 1_000_000;
  const gate = new SelfClearGate(() => now);
  if (over.inFlight) gate.workerClearStart('proj-a');
  const injects: Array<[string, string]> = [];
  const voice: string[] = [];
  const bells: string[] = [];
  const delayed: Array<{ fn: () => void; ms: number }> = [];
  const asks: string[] = [];
  const transcripts = over.transcripts ?? ['C:/t/old.jsonl'];
  const files = new Map<string, string>();
  const deps: LexSelfClearDeps = {
    gate,
    brainstormCwd: BRAINSTORM_CWD,
    askText: async (i) => {
      asks.push(i.prompt);
      return over.judge === undefined ? 'OK' : over.judge;
    },
    facts: () => ({
      workerHead: 'abc1234deadbeef',
      workerBranch: 'voice-layers',
      workerSessionId: 'cc-worker-a',
      planExists: (ref) => ref === 'docs/plan.md',
      pendingHandoverId: null,
      pendingDispatch: null,
    }),
    contextPack: () => '## Your worker: proj-a\n- git: HEAD abc1234',
    ctxPct: () => 74,
    setpoint: () => 70,
    lexPtyFor: () => 'pty-lex',
    ptyInject: (p, t) => {
      injects.push([p, t]);
      return { ok: true };
    },
    notifyVoice: async (_b, t) => {
      voice.push(t);
      return true;
    },
    bell: (i) => {
      bells.push(i.title);
    },
    newestTranscript: () => transcripts[transcripts.length - 1] ?? null,
    readFile: (p) => files.get(p) ?? null,
    delay: (fn, ms) => {
      delayed.push({ fn, ms });
    },
    fs: { rootDir: path.join(tmpDir, 'brainstorms').replace(/\\/g, '/') },
    now: () => now,
    currentSessionId: () => 'cc-lex-1',
  };
  registerLexSelfClearRoutes(app, db, () => undefined, deps);
  return {
    app,
    gate,
    injects,
    voice,
    bells,
    delayed,
    asks,
    transcripts,
    files,
    tick: (ms: number) => (now += ms),
    rootDir: deps.fs!.rootDir!,
  };
}

describe('lex self-clear routes', () => {
  it('state reports ctx, setpoint and due', async () => {
    const { app } = build();
    const r = await app.inject({ method: 'GET', url: '/lex/self-clear/state?brainstorm_id=bs-1' });
    expect(r.json()).toMatchObject({ ok: true, ctx_pct: 74, setpoint: 70, due: true, worker_clear_in_flight: false });
    expect((await app.inject({ method: 'GET', url: '/lex/self-clear/state?brainstorm_id=nope' })).statusCode).toBe(404);
    const pack = await app.inject({ method: 'GET', url: '/lex/context-pack?brainstorm_id=bs-1' });
    expect((pack.json() as { pack: string }).pack).toContain('## Your worker: proj-a');
  });

  it('refuses with 409 while a worker clear is in flight', async () => {
    const { app, injects } = build({ inFlight: true });
    const r = await app.inject({ method: 'POST', url: '/lex/self-clear', payload: BODY });
    expect(r.statusCode).toBe(409);
    expect(injects).toEqual([]);
  });

  it('a NO from the judge is a 422 and the refusal is visible in the file', async () => {
    const { app, injects, rootDir } = build({ judge: 'NO: the next steps do not name the plan task' });
    const r = await app.inject({ method: 'POST', url: '/lex/self-clear', payload: BODY });
    expect(r.statusCode).toBe(422);
    const j = r.json() as { issues: string[]; handover_id: string };
    expect(j.issues).toEqual(['judge: the next steps do not name the plan task']);
    const onDisk = fs.readFileSync(path.join(rootDir, 'bs-1', j.handover_id), 'utf-8');
    expect(onDisk).toMatch(/^## Lex draft \(lex session cc-lex-1, /m);
    expect(onDisk).toMatch(/^## Judge review \(rejected, session none, /m);
    expect(onDisk).toContain('- judge: NO, the next steps do not name the plan task');
    expect(injects).toEqual([]);
  });

  it('a fact-check miss is a 422 too, with the judge shown the flag', async () => {
    const { app, asks } = build();
    const r = await app.inject({
      method: 'POST',
      url: '/lex/self-clear',
      payload: { ...BODY, draft: { ...DRAFT, verified_state: 'The worker is at HEAD 1234abc.' } },
    });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { issues: string[] }).issues[0]).toMatch(/commit 1234abc is not the worker's HEAD/);
    expect(asks[0]).toContain('automatic checks flagged');
  });

  it('approved: writes the file, tells the voice, types /clear, kicks, serves the handoff once', async () => {
    const { app, gate, injects, voice, delayed, rootDir, files, transcripts, bells } = build();
    const r = await app.inject({ method: 'POST', url: '/lex/self-clear', payload: BODY });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { handover_id: string; verdict: string; cleared: boolean; reseed_chars: number };
    expect(j.verdict).toBe('approved');
    expect(j.cleared).toBe(true);
    const onDisk = fs.readFileSync(path.join(rootDir, 'bs-1', j.handover_id), 'utf-8');
    expect(onDisk).toMatch(/^## Judge review \(approved, session none, /m);
    expect(onDisk).toContain('- judge: OK');
    expect(voice[0]).toMatch(/clearing its own context at 74%/);
    expect(injects).toEqual([['pty-lex', '/clear']]);
    expect(gate.lexClearPending('bs-1')).toBe(true);

    /* The hook fetches the handoff: brainstorm cwd only, once. */
    const other = await app.inject({ method: 'POST', url: '/lex/clear-handoff', payload: { session_id: 'x', cwd: 'C:/p/proj-a' } });
    expect(other.json()).toMatchObject({ ok: true, block: '', reason: 'not-brainstorm-cwd' });
    const served = await app.inject({
      method: 'POST',
      url: '/lex/clear-handoff',
      payload: { session_id: 'cc-lex-2', cwd: 'c:\\data\\brainstorm\\' },
    });
    const sj = served.json() as { block: string; reason: string; handover_id: string };
    expect(sj.reason).toBe('lex-self-clear');
    expect(sj.handover_id).toBe(j.handover_id);
    expect(sj.block).toMatch(/^Resume from your lex-self-clear handover of .* \(judge: approved\)\./);
    expect(sj.block).toContain('Next steps: Watch the worker finish Task 9, then Task 12.');
    expect(sj.block).toContain('## Your worker: proj-a');
    expect(sj.block.length).toBe(j.reseed_chars);
    const again = await app.inject({ method: 'POST', url: '/lex/clear-handoff', payload: { session_id: 'cc-lex-2', cwd: BRAINSTORM_CWD } });
    expect(again.json()).toMatchObject({ block: '', reason: 'none-pending' });

    /* The kick: the hook served, so a short first turn. */
    expect(delayed).toHaveLength(1);
    delayed[0]!.fn();
    expect(injects).toHaveLength(2);
    expect(injects[1]![1]).toMatch(/^Resume from your lex-self-clear handover of .* It is in your session context above\./);
    expect(injects[1]![1]).not.toContain('## Your worker');

    /* Resume confirm: the new transcript carries the kick and a reply. */
    transcripts.push('C:/t/new.jsonl');
    files.set(
      'C:/t/new.jsonl',
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: injects[1]![1] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Back. Task 9 next.' }] } }),
      ].join('\n'),
    );
    expect(delayed).toHaveLength(2);
    delayed[1]!.fn();
    expect(bells).toEqual([]);
    expect(injects).toHaveLength(2);
  });

  it('when nobody fetched the handoff the kick carries the whole reseed, and a silent session gets one re-paste then a bell', async () => {
    const { app, injects, delayed, bells, transcripts, files } = build();
    await app.inject({ method: 'POST', url: '/lex/self-clear', payload: BODY });
    delayed[0]!.fn();
    expect(injects[1]![1]).toContain('## Your worker: proj-a');
    /* A new transcript with no assistant reply at all. */
    transcripts.push('C:/t/new.jsonl');
    files.set('C:/t/new.jsonl', JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }));
    delayed[1]!.fn();
    expect(injects).toHaveLength(3);
    expect(injects[2]![1]).toMatch(/^You just cleared your context\. Your handover:/);
    delayed[2]!.fn();
    expect(bells).toEqual(['Lex may not have resumed after her clear']);
  });

  it('judge unavailable: structural vet and fact check decide, and the file says so', async () => {
    const { app, rootDir } = build({ judge: null });
    const r = await app.inject({ method: 'POST', url: '/lex/self-clear', payload: BODY });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { handover_id: string };
    const onDisk = fs.readFileSync(path.join(rootDir, 'bs-1', j.handover_id), 'utf-8');
    expect(onDisk).toContain('- judge: unavailable (structural vet and fact check only)');
  });
});
