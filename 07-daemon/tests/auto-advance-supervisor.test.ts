/* Autonomous supervisor phase 3 tick.
 *
 * Pins the three contracts the user named:
 *   1. shadow log emitted when all gates pass.
 *   2. no shadow log when the assistant turn carries no footer.
 *   3. no shadow log when the footer reports needs_input=true.
 *
 * The supervisor also writes decision='skip' rows so the operator
 * can audit why a tick bailed; tests assert those negative paths
 * produce no decision='shadow' rows. The atomic claim primitive
 * sits behind a stub so the test exercises the gates without
 * standing up the full backlog-store.
 *
 * Quiescence relies on the supervisor's in-memory state across
 * two ticks; tests drive that by running the tick twice with the
 * same memory map.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  AUTO_ADVANCE_CONFIG_KEY,
  runAutoAdvanceTick,
  type AutoAdvanceTickDeps,
} from '../src/lex/auto-advance-supervisor.js';
import type {
  BacklogItemRow,
  ProjectSessionRow,
} from '../src/store/index-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-auto-advance-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  db.setRuntimeConfig(AUTO_ADVANCE_CONFIG_KEY, 'shadow', 'test');
  /* auto_advance_log has FK anchor_id -> project_session(id) with
   * foreign_keys=ON, so the test must seed the matching anchor row
   * for every anchor the tick will insert a log for. */
  db.insertProjectSession({
    id: 'a-1',
    project_slug: 'demo',
    cwd: 'c:/dev/Projects/demo',
    title: 'demo',
    status: 'live',
    current_session_id: 's-1',
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1,
    last_seen_ms: 10,
    supervision_mode: 'event',
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeAnchor(overrides: Partial<ProjectSessionRow> = {}): ProjectSessionRow {
  return {
    id: 'a-1',
    project_slug: 'demo',
    cwd: 'c:/dev/Projects/demo',
    title: 'demo',
    status: 'live',
    current_session_id: 's-1',
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: 1,
    last_seen_ms: 10,
    supervision_mode: 'event',
    auto_advance_owner: null,
    auto_advance_epoch: 0,
    ...overrides,
  };
}

function makeBacklog(): BacklogItemRow {
  return {
    id: 'item-1',
    title: 'do the next thing',
    status: 'queued',
    priority: 'urgent',
    added_at: '2026-05-16T00:00:00Z',
    injected_at: null,
    done_at: null,
    commit_shas: null,
    claimed_by: null,
    claimed_at: null,
    claimed_turn_uuid: null,
    anchor_id: null,
    notes: null,
  };
}

function assistantTurnJsonl(uuid: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text }] },
  });
}

function footerForDone(): string {
  return [
    'All landed.',
    '',
    '<!-- worker-status',
    'status=done',
    'backlog_item_id=prev-task',
    'commit_sha=abcd123',
    'tests=pass',
    'needs_attention=false',
    '-->',
  ].join('\n');
}

function footerForNeedsInput(): string {
  return [
    'Which path do you want?',
    '',
    '<!-- worker-status',
    'status=needs_input',
    'backlog_item_id=none',
    'commit_sha=none',
    'tests=none',
    'needs_attention=true',
    '-->',
  ].join('\n');
}

function buildDeps(opts: {
  anchors: ProjectSessionRow[];
  jsonlByAnchor: Map<string, string>;
  backlog: BacklogItemRow[];
  claim?: AutoAdvanceTickDeps['claimBacklog'];
  memory?: Map<string, unknown>;
  now?: number;
  /* Stub lease bumper so the test doesn't have to insert real
   * project_session rows. Default returns a monotonically
   * increasing epoch on every call. */
  bumpLease?: AutoAdvanceTickDeps['bumpLease'];
}): AutoAdvanceTickDeps {
  let epochCounter = 0;
  const backlog = opts.backlog.slice();
  return {
    db,
    listAnchors: () => opts.anchors,
    listBacklog: ({ status }) =>
      status
        ? backlog.filter((b) => b.status === status)
        : backlog.slice(),
    claimBacklog:
      opts.claim ??
      ((input) => {
        const item = backlog.find((b) => b.id === input.id);
        if (!item) return { ok: false, reason: 'not-found' };
        if (item.status !== 'queued') {
          return { ok: false, reason: 'already-claimed', row: item };
        }
        item.status = 'in-flight';
        item.claimed_by = input.claimed_by;
        item.claimed_at = new Date().toISOString();
        item.claimed_turn_uuid = input.claimed_turn_uuid ?? null;
        item.anchor_id = input.anchor_id ?? null;
        return { ok: true, row: item };
      }),
    listPtys: () => [],
    readJsonl: (p) => opts.jsonlByAnchor.get(p) ?? null,
    resolveJsonlPath: (anchor) => `mem://${anchor.id}`,
    memory:
      (opts.memory as Map<string, never>) ??
      new Map<string, never>(),
    bumpLease:
      opts.bumpLease ??
      (() => {
        epochCounter += 1;
        return epochCounter;
      }),
    now: () => opts.now ?? 1_000_000,
  };
}

describe('runAutoAdvanceTick', () => {
  it('emits a shadow log when all gates pass', async () => {
    const anchor = makeAnchor();
    const jsonl = assistantTurnJsonl('turn-1', footerForDone());
    const memory = new Map();
    const deps = buildDeps({
      anchors: [anchor],
      jsonlByAnchor: new Map([['mem://a-1', jsonl]]),
      backlog: [makeBacklog()],
      memory: memory as never,
    });
    /* First tick observes the assistant turn; the stability rule
     * requires the SAME uuid across two ticks before advancing. */
    const first = await runAutoAdvanceTick(deps);
    expect(first.map((r) => r.decision)).toEqual(['skip']);
    expect(first[0]?.reason).toBe('awaiting-stability');
    const second = await runAutoAdvanceTick(deps);
    expect(second).toHaveLength(1);
    expect(second[0]?.decision).toBe('shadow');
    expect(second[0]?.item_id).toBe('item-1');
    expect(second[0]?.turn_uuid).toBe('turn-1');
    /* Persisted log row carries decision='shadow' and the would-be
     * inject preview text. */
    const rows = db.listAutoAdvanceLog({ anchor_id: anchor.id });
    const shadow = rows.find((r) => r.decision === 'shadow');
    expect(shadow).toBeDefined();
    expect(shadow?.would_inject_preview ?? '').toMatch(/item-1/);
    expect(shadow?.footer_status).toBe('done');
    expect(shadow?.footer_needs_attention).toBe(0);
    expect(shadow?.mode).toBe('shadow');
  });

  it('emits NO shadow log when the footer is missing', async () => {
    const anchor = makeAnchor();
    const jsonl = assistantTurnJsonl(
      'turn-2',
      'All landed. No footer here for some reason.',
    );
    const memory = new Map();
    const deps = buildDeps({
      anchors: [anchor],
      jsonlByAnchor: new Map([['mem://a-1', jsonl]]),
      backlog: [makeBacklog()],
      memory: memory as never,
    });
    await runAutoAdvanceTick(deps);
    const records = await runAutoAdvanceTick(deps);
    expect(records[0]?.decision).toBe('skip');
    expect(records[0]?.reason).toBe('no-footer');
    const rows = db.listAutoAdvanceLog({ anchor_id: anchor.id });
    /* The supervisor logs the skip so an operator can audit it,
     * but NO row carries decision='shadow' / 'accepted'. */
    expect(rows.some((r) => r.decision === 'shadow')).toBe(false);
    expect(rows.some((r) => r.decision === 'accepted')).toBe(false);
    expect(rows.some((r) => r.reason === 'no-footer')).toBe(true);
  });

  it('emits NO shadow log when needs_input=true', async () => {
    const anchor = makeAnchor();
    const jsonl = assistantTurnJsonl('turn-3', footerForNeedsInput());
    const memory = new Map();
    const deps = buildDeps({
      anchors: [anchor],
      jsonlByAnchor: new Map([['mem://a-1', jsonl]]),
      backlog: [makeBacklog()],
      memory: memory as never,
    });
    await runAutoAdvanceTick(deps);
    const records = await runAutoAdvanceTick(deps);
    expect(records[0]?.decision).toBe('skip');
    /* status=needs_input is captured by the status gate, which
     * reports reason='status-needs_input' so the operator can
     * filter on the specific failure. */
    expect(records[0]?.reason).toBe('status-needs_input');
    const rows = db.listAutoAdvanceLog({ anchor_id: anchor.id });
    expect(rows.some((r) => r.decision === 'shadow')).toBe(false);
    expect(rows.some((r) => r.decision === 'accepted')).toBe(false);
  });

  it('emits no rows at all when auto_advance_mode is off', async () => {
    db.setRuntimeConfig(AUTO_ADVANCE_CONFIG_KEY, 'off', 'test');
    const anchor = makeAnchor();
    const jsonl = assistantTurnJsonl('turn-4', footerForDone());
    const deps = buildDeps({
      anchors: [anchor],
      jsonlByAnchor: new Map([['mem://a-1', jsonl]]),
      backlog: [makeBacklog()],
    });
    /* Two ticks would normally land a shadow; mode='off' kills the
     * loop entirely so the log stays empty. */
    await runAutoAdvanceTick(deps);
    await runAutoAdvanceTick(deps);
    const rows = db.listAutoAdvanceLog({});
    expect(rows).toHaveLength(0);
  });

  it('refuses to advance the same assistant turn twice', async () => {
    const anchor = makeAnchor();
    const jsonl = assistantTurnJsonl('turn-stable', footerForDone());
    const memory = new Map();
    const backlog = [makeBacklog(), { ...makeBacklog(), id: 'item-2' }];
    const deps = buildDeps({
      anchors: [anchor],
      jsonlByAnchor: new Map([['mem://a-1', jsonl]]),
      backlog,
      memory: memory as never,
    });
    await runAutoAdvanceTick(deps); // observe
    const first = await runAutoAdvanceTick(deps); // shadow fire
    expect(first[0]?.decision).toBe('shadow');
    const second = await runAutoAdvanceTick(deps); // same turn uuid
    /* Same turn uuid means the supervisor has already advanced
     * this completion; refuse to fire a second time. */
    expect(second[0]?.decision).toBe('skip');
    expect(second[0]?.reason).toBe('already-advanced-this-turn');
    const shadowRows = db
      .listAutoAdvanceLog({ anchor_id: anchor.id })
      .filter((r) => r.decision === 'shadow');
    expect(shadowRows).toHaveLength(1);
  });

  it('skips anchors with supervision_mode != event', async () => {
    const anchor = makeAnchor({ supervision_mode: 'polling' });
    const jsonl = assistantTurnJsonl('turn-5', footerForDone());
    const deps = buildDeps({
      anchors: [anchor],
      jsonlByAnchor: new Map([['mem://a-1', jsonl]]),
      backlog: [makeBacklog()],
    });
    await runAutoAdvanceTick(deps);
    await runAutoAdvanceTick(deps);
    const rows = db.listAutoAdvanceLog({});
    /* polling supervision keeps the anchor on the legacy cron
     * path; the auto-advance loop must not even consider it. */
    expect(rows).toHaveLength(0);
  });

  it('skips when the backlog is empty', async () => {
    const anchor = makeAnchor();
    const jsonl = assistantTurnJsonl('turn-6', footerForDone());
    const memory = new Map();
    const deps = buildDeps({
      anchors: [anchor],
      jsonlByAnchor: new Map([['mem://a-1', jsonl]]),
      backlog: [],
      memory: memory as never,
    });
    await runAutoAdvanceTick(deps);
    const records = await runAutoAdvanceTick(deps);
    expect(records[0]?.decision).toBe('skip');
    expect(records[0]?.reason).toBe('backlog-empty');
    const rows = db.listAutoAdvanceLog({ anchor_id: anchor.id });
    expect(rows.some((r) => r.decision === 'shadow')).toBe(false);
  });
});
