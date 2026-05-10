/**
 * Wave 2 day 5 step 24 + 24a. lex_feedback insert + up-rate +
 * meeting_action_items insert + status update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let priorRoot: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-d5-')).replace(/\\/g, '/');
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const { IndexDb } = await import('../src/store/index-db.js');
  const bootstrap = new IndexDb(dbFile);
  bootstrap.close();
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('lex_feedback', () => {
  it('insert + per-version up-rate aggregation', async () => {
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    db.insertLexFeedback({ id: 'lf-a', turn_id: 't1', prompt_version: 'v1', vote: 'up' });
    db.insertLexFeedback({ id: 'lf-b', turn_id: 't2', prompt_version: 'v1', vote: 'up' });
    db.insertLexFeedback({ id: 'lf-c', turn_id: 't3', prompt_version: 'v1', vote: 'down' });
    db.insertLexFeedback({ id: 'lf-d', turn_id: 't4', prompt_version: 'v2', vote: 'down' });
    const v1 = db.lexFeedbackUpRate('v1');
    expect(v1).toEqual({ up: 2, down: 1, total: 3, up_rate: 2 / 3 });
    const v2 = db.lexFeedbackUpRate('v2');
    expect(v2.up_rate).toBe(0);
    const all = db.listLexFeedback({ prompt_version: 'v1' });
    expect(all).toHaveLength(3);
    db.close();
  });
});

describe('meeting_action_items', () => {
  it('insert + status update terminal stamp', async () => {
    const { IndexDb } = await import('../src/store/index-db.js');
    const db = new IndexDb(dbFile);
    db.insertBrainstorm({
      id: 'mt-1', claude_session_id: null, pty_id: null, cwd: tmpDir,
      user_label: 'Q2 review', derived_label: null, mode: 'notes',
      status: 'ended', started_ms: Date.now() - 5000, ended_ms: Date.now(),
      turn_count: 5, topic_tags_json: '[]', artifacts_json: '{}',
      last_summary: 's', last_summary_ms: Date.now(),
    });
    db.setBrainstormPhaseTwo('mt-1', { kind: 'meeting' });
    db.insertMeetingActionItem({
      id: 'a1', meeting_id: 'mt-1', text: 'follow up with finance', assignee: 'mike', due: '2026-06-01',
    });
    db.insertMeetingActionItem({
      id: 'a2', meeting_id: 'mt-1', text: 'draft the proposal',
    });
    const list = db.listMeetingActionItems('mt-1');
    expect(list).toHaveLength(2);
    expect(list[0]?.assignee).toBe('mike');
    const done = db.updateMeetingActionItemStatus('a1', 'done');
    expect(done?.status).toBe('done');
    expect(done?.resolved_at).not.toBeNull();
    /* Open status (the SQLite default) clears resolved_at. */
    const reopened = db.updateMeetingActionItemStatus('a1', 'open');
    expect(reopened?.status).toBe('open');
    expect(reopened?.resolved_at).toBeNull();
    db.close();
  });
});
