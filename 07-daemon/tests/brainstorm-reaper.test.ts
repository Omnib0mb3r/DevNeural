/* Bug: 2026-05-11-past-sessions-orphan-pollution.
 *
 * On every daemon boot, reapAllActive walks rows stuck at status='active'
 * (left over from PTY teardowns the previous daemon never finished).
 * Pre-fix: every row got marked ended with last_summary="daemon restart:
 * ...", regardless of whether the session had any chunks, audio, or
 * distilled summary. Auto-spawn shells the user never typed into piled
 * up at the top of the Past Sessions list and buried real work past the
 * 50-row page.
 *
 * Post-fix: rows with zero substance (no chunks, no audio, no distilled)
 * are deleted outright. Rows with any of those signals are still marked
 * ended in place so the history survives.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { reapAllActive, setStore } from '../src/lex/brainstorm-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-reap-'));
  dbFile = path.join(tmpDir, 'index.db');
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  setStore({ db });
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedActive(opts: { id?: string; withChunk?: boolean; withAudio?: boolean } = {}): string {
  const id = opts.id ?? randomUUID();
  db.insertBrainstorm({
    id,
    claude_session_id: null,
    pty_id: null,
    cwd: '/tmp/brainstorm',
    user_label: null,
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: Date.now() - 60_000,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
  if (opts.withChunk) {
    db.insertBrainstormChunk({
      id: randomUUID(),
      brainstorm_id: id,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'real',
      model_id: 'opus',
    });
  }
  if (opts.withAudio) {
    db['db']
      .prepare(`UPDATE brainstorm_sessions SET audio_path = ? WHERE id = ?`)
      .run('/tmp/bundle.wav', id);
  }
  return id;
}

describe('reapAllActive substance gate', () => {
  it('deletes empty active rows on boot', () => {
    const id = seedActive();
    const touched = reapAllActive('daemon restart: orphaned active session');
    expect(touched).toBe(1);
    expect(db.getBrainstorm(id)).toBeNull();
  });

  it('marks rows with chunks ended in place, not deleted', () => {
    const id = seedActive({ withChunk: true });
    const touched = reapAllActive('daemon restart: orphaned active session');
    expect(touched).toBe(1);
    const row = db.getBrainstorm(id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('ended');
    /* Reaper must NOT write a reap reason into last_summary. That
     * column belongs to the distillation pipeline; the reap reason
     * stays in the daemon log only. Bug: cold-start preload was
     * reading reap reasons as one-line distillations. */
    expect(row?.last_summary).toBeNull();
    expect(row?.last_summary_ms).toBeNull();
    expect(row?.turn_count).toBe(1);
  });

  it('preserves an existing distillation when reaping', () => {
    const id = seedActive({ withChunk: true });
    /* Simulate a real distillation already landed before the daemon
     * crashed. The reaper must not stomp it. */
    db.updateBrainstorm(id, {
      last_summary: '**Topic**: refactor X. **Key decisions**: chose Y.',
      last_summary_ms: Date.now() - 1000,
    });
    reapAllActive('daemon restart: orphaned active session');
    const row = db.getBrainstorm(id);
    expect(row?.status).toBe('ended');
    expect(row?.last_summary).toMatch(/Topic/);
    expect(row?.last_summary).toMatch(/Key decisions/);
  });

  it('marks rows with audio_path ended in place', () => {
    const id = seedActive({ withAudio: true });
    reapAllActive('daemon restart: orphaned active session');
    const row = db.getBrainstorm(id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('ended');
  });

  it('past-sessions feed surfaces no orphan rows after a double restart', () => {
    seedActive();
    seedActive();
    seedActive({ withChunk: true });
    reapAllActive('daemon restart: orphaned active session');
    /* Simulate a second boot: nothing left active, so reaper is a
     * no-op. Empty rows from the first pass were deleted, not left
     * behind. */
    expect(reapAllActive('daemon restart: orphaned active session')).toBe(0);
    const visible = db.listBrainstormsFiltered({});
    expect(visible).toHaveLength(1);
    expect(visible[0]?.turn_count).toBe(1);
  });
});
