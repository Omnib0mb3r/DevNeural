import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { withSessionEndLock, _activeLockCount } from '../src/lex/session-end-lock.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;
let priorProvider: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-step20-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  priorProvider = process.env.DEVNEURAL_LLM_PROVIDER;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  /* Force the LLM provider off for tests so distillation lands in
   * its no_provider gate; otherwise pickProvider could find a live
   * ollama on the host and the test would hang on a real LLM call. */
  process.env.DEVNEURAL_LLM_PROVIDER = 'none';
  db = new IndexDb(dbFile);
  db.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  if (priorProvider === undefined) delete process.env.DEVNEURAL_LLM_PROVIDER;
  else process.env.DEVNEURAL_LLM_PROVIDER = priorProvider;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session-end pipeline (BF-7 step 20)', () => {
  it('per-session lock funnels concurrent calls through a single runner', async () => {
    let primaryRuns = 0;
    const work = async () => {
      primaryRuns += 1;
      await new Promise((r) => setTimeout(r, 30));
      return primaryRuns;
    };
    const [a, b, c] = await Promise.all([
      withSessionEndLock('s1', work),
      withSessionEndLock('s1', work),
      withSessionEndLock('s1', work),
    ]);
    expect(primaryRuns).toBe(1);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
    expect(_activeLockCount()).toBe(0);
  });

  it('lock releases on rejection so future runs can proceed', async () => {
    await expect(
      withSessionEndLock('s2', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(_activeLockCount()).toBe(0);
    /* Future call on the same session_id must run a fresh primary. */
    let ran = false;
    const r = await withSessionEndLock('s2', async () => {
      ran = true;
      return 42;
    });
    expect(ran).toBe(true);
    expect(r).toBe(42);
  });

  it('different session_ids run in parallel', async () => {
    const order: string[] = [];
    const work = (label: string) => async () => {
      order.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`${label}:end`);
      return label;
    };
    await Promise.all([
      withSessionEndLock('sA', work('A')),
      withSessionEndLock('sB', work('B')),
    ]);
    /* Both starts should appear before either end if they overlap. */
    const aStart = order.indexOf('A:start');
    const bStart = order.indexOf('B:start');
    const aEnd = order.indexOf('A:end');
    const bEnd = order.indexOf('B:end');
    expect(Math.max(aStart, bStart)).toBeLessThan(Math.min(aEnd, bEnd));
  });

  it('insertWikiDraft persists with default status=pending', () => {
    db.insertBrainstorm({
      id: 'bs-d-1',
      claude_session_id: 'cc-d-1',
      pty_id: null,
      cwd: tmpDir,
      user_label: 'test',
      derived_label: null,
      mode: 'conversation',
      status: 'ended',
      started_ms: Date.now() - 1000,
      ended_ms: Date.now(),
      turn_count: 5,
      topic_tags_json: '[]',
      artifacts_json: '{}',
      last_summary: 's',
      last_summary_ms: Date.now(),
    });
    db.insertWikiDraft({
      id: 'draft-1',
      brainstorm_id: 'bs-d-1',
      page_slug: 'sample-pattern',
      page_title: 'Sample pattern',
      body_markdown: '# Sample\n\n## Pattern\nbody.',
      confidence: 0.7,
    });
    /* Use the existing better-sqlite3 path to read back. */
    const Database = require('better-sqlite3');
    const raw = new Database(dbFile);
    try {
      const row = raw
        .prepare(`SELECT * FROM wiki_drafts WHERE id = ?`)
        .get('draft-1');
      expect(row.status).toBe('pending');
      expect(row.confidence).toBeCloseTo(0.7, 4);
      expect(row.brainstorm_id).toBe('bs-d-1');
      expect(row.page_slug).toBe('sample-pattern');
    } finally {
      raw.close();
    }
  });

  it('setBrainstormDistilledAt updates the row', () => {
    db.insertBrainstorm({
      id: 'bs-d-2',
      claude_session_id: 'cc-d-2',
      pty_id: null,
      cwd: tmpDir,
      user_label: 't',
      derived_label: null,
      mode: 'conversation',
      status: 'ended',
      started_ms: Date.now() - 1000,
      ended_ms: Date.now(),
      turn_count: 1,
      topic_tags_json: '[]',
      artifacts_json: '{}',
      last_summary: null,
      last_summary_ms: null,
    });
    const ts = '2026-05-10T20:00:00.000Z';
    db.setBrainstormDistilledAt('bs-d-2', ts);
    const row = db.getBrainstorm('bs-d-2');
    expect(row?.distilled_at).toBe(ts);
  });

  it('brainstormKind returns brainstorm by default and meeting when set', () => {
    db.insertBrainstorm({
      id: 'bs-k-1',
      claude_session_id: 'cc-k-1',
      pty_id: null,
      cwd: tmpDir,
      user_label: null,
      derived_label: null,
      mode: 'conversation',
      status: 'ended',
      started_ms: Date.now(),
      ended_ms: null,
      turn_count: 0,
      topic_tags_json: '[]',
      artifacts_json: '{}',
      last_summary: null,
      last_summary_ms: null,
    });
    expect(db.brainstormKind('bs-k-1')).toBe('brainstorm');
    const Database = require('better-sqlite3');
    const raw = new Database(dbFile);
    try {
      raw.prepare(`UPDATE brainstorm_sessions SET kind = 'meeting' WHERE id = ?`).run('bs-k-1');
    } finally {
      raw.close();
    }
    expect(db.brainstormKind('bs-k-1')).toBe('meeting');
  });

  it('distillBrainstorm refuses when no provider configured', async () => {
    const { distillBrainstorm } = await import('../src/lex/brainstorm-distillation.js');
    const transcript = 'USER: I want a wiki page about widget pooling.\n'.repeat(20);
    const result = await distillBrainstorm(db as never, 'bs-x-1', transcript, () => undefined);
    expect(result.drafts_created).toBe(0);
    expect(result.skipped_reason).toBe('no_provider');
  });

  it('distillBrainstorm refuses on transcript_too_short before provider check', async () => {
    const { distillBrainstorm } = await import('../src/lex/brainstorm-distillation.js');
    const result = await distillBrainstorm(db as never, 'bs-x-2', 'tiny', () => undefined);
    expect(result.skipped_reason).toBe('transcript_too_short');
  });
});
