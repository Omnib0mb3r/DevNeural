/**
 * Worker event kill-switch persistence
 * (EVENT-DRIVEN-SUPERVISION.md hard ceiling: too many events /10m
 * forces the offending anchor back to supervision_mode='polling'
 * and surfaces a warn notification).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  applyKillSwitch,
  bindKillSwitch,
} from '../src/dashboard/worker-event-killswitch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-ks-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'Projects');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } })
    .db.prepare('DELETE FROM project_session')
    .run();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seed(opts: { id: string; mode: 'event' | 'polling' | 'off' }): void {
  db.insertProjectSession({
    id: opts.id,
    project_slug: opts.id,
    cwd: `C:/p/${opts.id}`,
    title: opts.id,
    status: 'live',
    current_session_id: 'cc-' + opts.id,
    current_bridge_id: 'b-' + opts.id,
    current_pty_id: 'pty-' + opts.id,
    created_ms: 1,
    last_seen_ms: 1,
    supervision_mode: opts.mode,
  });
}

describe('applyKillSwitch', () => {
  it('flips supervision_mode from event to polling', () => {
    seed({ id: 'a', mode: 'event' });
    const emit = vi.fn().mockReturnValue({ id: 'n-1' });
    const r = applyKillSwitch(db, 'a', { emit });
    expect(r.next_mode).toBe('polling');
    expect(r.prior_mode).toBe('event');
    expect(r.already_tripped).toBe(false);
    expect(db.getProjectSession('a')?.supervision_mode).toBe('polling');
  });

  it('emits a warn notification with /projects link', () => {
    seed({ id: 'a', mode: 'event' });
    const emit = vi.fn().mockReturnValue({ id: 'n-1' });
    applyKillSwitch(db, 'a', { emit });
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0] as {
      severity: string;
      source: string;
      title: string;
      link: string;
    };
    expect(arg.severity).toBe('warn');
    expect(arg.source).toBe('supervision');
    expect(arg.title).toMatch(/kill-switch tripped/);
    expect(arg.link).toBe('/projects');
  });

  it('is idempotent on already-polling rows: no mode change, still emits', () => {
    seed({ id: 'a', mode: 'polling' });
    const emit = vi.fn().mockReturnValue({ id: 'n-1' });
    const r = applyKillSwitch(db, 'a', { emit });
    expect(r.next_mode).toBe('polling');
    expect(r.prior_mode).toBe('polling');
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('skips the notification on a duplicate trip via alreadyTripped set', () => {
    seed({ id: 'a', mode: 'event' });
    const emit = vi.fn().mockReturnValue({ id: 'n-1' });
    const tripped = new Set<string>();
    applyKillSwitch(db, 'a', { emit, alreadyTripped: tripped });
    const r2 = applyKillSwitch(db, 'a', { emit, alreadyTripped: tripped });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(r2.already_tripped).toBe(true);
    expect(r2.notification_id).toBeNull();
  });

  it('handles a missing anchor row by emitting with an id-prefix label', () => {
    const emit = vi.fn().mockReturnValue({ id: 'n-1' });
    const r = applyKillSwitch(db, 'orphan-id-12345', { emit });
    expect(r.next_mode).toBe('polling');
    const arg = emit.mock.calls[0]![0] as { title: string };
    expect(arg.title).toMatch(/orphan-i/);
  });
});

describe('bindKillSwitch', () => {
  it('returns a callable that runs applyKillSwitch with the bound deps', () => {
    seed({ id: 'a', mode: 'event' });
    const emit = vi.fn().mockReturnValue({ id: 'n-1' });
    const handler = bindKillSwitch(db, { emit });
    handler('a');
    expect(db.getProjectSession('a')?.supervision_mode).toBe('polling');
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
