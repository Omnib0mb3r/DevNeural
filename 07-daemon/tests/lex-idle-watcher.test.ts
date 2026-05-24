/**
 * Idle-watcher integration (Phase 2 of LSS).
 *
 * Drives the watcher's tick synchronously via tickNow() so the test
 * does not depend on setInterval timing. Verifies the scan-and-fire
 * decision and the listIdleActivity surface the dashboard panel
 * consumes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  listIdleActivity,
  startIdleWatcher,
} from '../src/lex/idle-watcher.js';
import { GROOMING_THRESHOLDS_MS } from '../src/lex/grooming.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-idle-watcher-'));
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'EmptyProjectsRoot'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'EmptyProjectsRoot');
  process.env.HOME = path.join(tmpDir, 'home');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  const dbFile = path.join(tmpDir, 'index.db');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  delete process.env.DEVNEURAL_DATA_ROOT;
  delete process.env.DEVNEURAL_PROJECTS_ROOT;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* tolerate windows file-lock races */
  }
});

function seed(opts: {
  id: string;
  lifecycle: 'idle' | 'attached' | 'speaking' | 'ended';
  silenceMs: number;
}) {
  const startedMs = NOW - opts.silenceMs - 1000;
  const utteranceIso = new Date(NOW - opts.silenceMs).toISOString();
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: `/synthetic/${opts.id}`,
    user_label: 'Idle Watcher Test',
    derived_label: null,
    mode: 'conversation',
    status: opts.lifecycle === 'ended' ? 'ended' : 'active',
    started_ms: startedMs,
    ended_ms: opts.lifecycle === 'ended' ? NOW : null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
  db.updateBrainstorm(opts.id, {
    lifecycle_state: opts.lifecycle,
    last_user_utterance_at: utteranceIso,
  });
  /* Two chunks so the grooming pass + summary path has source. */
  db.insertBrainstormChunk({
    id: `${opts.id}-c0`,
    brainstorm_id: opts.id,
    turn_index: 0,
    role: 'user',
    mode: 'conversation',
    text: 'sample user turn',
    model_id: '',
    no_decay: 1,
  });
  db.insertBrainstormChunk({
    id: `${opts.id}-c1`,
    brainstorm_id: opts.id,
    turn_index: 1,
    role: 'lex',
    mode: 'conversation',
    text: 'sample lex reply',
    model_id: 'claude',
    no_decay: 1,
  });
}

describe('startIdleWatcher tickNow', () => {
  it('fires a cold pass on an idle row past the cold threshold and skips a fresh row', async () => {
    seed({ id: 'bs-cold', lifecycle: 'idle', silenceMs: GROOMING_THRESHOLDS_MS.cold + 5000 });
    seed({ id: 'bs-fresh', lifecycle: 'idle', silenceMs: 1000 });
    const generator = vi.fn(async () => 'rolling summary');
    const writeHandover = vi.fn(() => ({
      filePath: '/synthetic/HANDOVER-x.md',
      bytes: 100,
    }));
    const sched = {
      set: () => 0,
      clear: () => undefined,
    };
    const watcher = startIdleWatcher({
      db,
      generator,
      writeHandover,
      now: () => NOW,
      scheduler: sched,
    });
    const results = await watcher.tickNow();
    expect(results).toHaveLength(1);
    expect(results[0]!.brainstormId).toBe('bs-cold');
    expect(results[0]!.kind).toBe('cold');
    expect(writeHandover).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('does NOT fire a pass on a speaking row regardless of silence', async () => {
    seed({
      id: 'bs-mid-utterance',
      lifecycle: 'speaking',
      silenceMs: GROOMING_THRESHOLDS_MS.cold + 60_000,
    });
    const generator = vi.fn(async () => 'should not be called');
    const sched = { set: () => 0, clear: () => undefined };
    const watcher = startIdleWatcher({
      db,
      generator,
      writeHandover: vi.fn(),
      now: () => NOW,
      scheduler: sched,
    });
    const results = await watcher.tickNow();
    expect(results).toHaveLength(0);
    expect(generator).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('fires for attached rows too (worker present but quiet)', async () => {
    seed({
      id: 'bs-attached-idle',
      lifecycle: 'attached',
      silenceMs: GROOMING_THRESHOLDS_MS.mid + 1000,
    });
    const generator = vi.fn(async () => 'rolling summary');
    const sched = { set: () => 0, clear: () => undefined };
    const watcher = startIdleWatcher({
      db,
      generator,
      writeHandover: vi.fn(() => ({ filePath: '/x', bytes: 1 })),
      now: () => NOW,
      scheduler: sched,
    });
    const results = await watcher.tickNow();
    expect(results.map((r) => r.brainstormId)).toContain('bs-attached-idle');
    expect(results.find((r) => r.brainstormId === 'bs-attached-idle')!.kind).toBe(
      'mid',
    );
    watcher.stop();
  });
});

describe('listIdleActivity', () => {
  it('returns one entry per idle/attached row sorted by silence DESC', () => {
    seed({ id: 'bs-coldest', lifecycle: 'idle', silenceMs: 2 * 60 * 60 * 1000 });
    seed({ id: 'bs-recent', lifecycle: 'attached', silenceMs: 60_000 });
    seed({ id: 'bs-ended', lifecycle: 'ended', silenceMs: 5 * 60 * 60 * 1000 });
    const rows = listIdleActivity(db, NOW);
    /* ended rows are excluded; speaking rows would be too. */
    expect(rows.map((r) => r.brainstormId)).toEqual(['bs-coldest', 'bs-recent']);
    expect(rows[0]!.silence_ms).toBeGreaterThan(rows[1]!.silence_ms);
    expect(rows[0]!.pending_pass).toBe('cold');
  });
});
