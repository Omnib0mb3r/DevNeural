import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { purgeMeetingAudio } from '../src/voice/meeting-audio-purge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');
const DAY_MS = 24 * 60 * 60 * 1000;

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let store: { db: IndexDb };
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-mapurge-'));
  dbFile = path.join(tmpDir, 'index.db');
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  store = { db };
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedMeeting(opts: {
  ageDays: number;
  keep_audio?: 0 | 1;
  withCues?: boolean;
}): { id: string; wavPath: string; cuesPath: string } {
  const id = randomUUID();
  const wavPath = path.join(tmpDir, `${id}.wav`);
  const cuesPath = path.join(tmpDir, `${id}.cues.json`);
  fs.writeFileSync(wavPath, Buffer.from([0, 0, 0, 0]));
  if (opts.withCues) fs.writeFileSync(cuesPath, '[]');
  const endedMs = Date.now() - opts.ageDays * DAY_MS;
  db.insertBrainstorm({
    id,
    claude_session_id: null,
    pty_id: null,
    cwd: '/tmp/brainstorm',
    user_label: null,
    derived_label: null,
    mode: 'notes',
    status: 'ended',
    started_ms: endedMs - 60_000,
    ended_ms: endedMs,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
  db.setBrainstormPhaseTwo(id, {
    kind: 'meeting',
    audio_path: wavPath,
    keep_audio: opts.keep_audio ?? 0,
  });
  return { id, wavPath, cuesPath };
}

describe('meeting audio purge', () => {
  it('deletes wav + cues sidecar for meetings past max-age', () => {
    const old = seedMeeting({ ageDays: 31, withCues: true });
    const r = purgeMeetingAudio(store as never, { maxAgeDays: 30 });
    expect(r.purged).toBe(1);
    expect(fs.existsSync(old.wavPath)).toBe(false);
    expect(fs.existsSync(old.cuesPath)).toBe(false);
    expect(db.getBrainstorm(old.id)?.audio_path).toBeNull();
  });

  it('skips meetings with keep_audio=1 even when past max-age', () => {
    const kept = seedMeeting({ ageDays: 60, keep_audio: 1 });
    const r = purgeMeetingAudio(store as never, { maxAgeDays: 30 });
    expect(r.skipped_keep_audio).toBe(1);
    expect(r.purged).toBe(0);
    expect(fs.existsSync(kept.wavPath)).toBe(true);
    expect(db.getBrainstorm(kept.id)?.audio_path).toBe(kept.wavPath);
  });

  it('skips meetings inside the retention window', () => {
    const fresh = seedMeeting({ ageDays: 5 });
    const r = purgeMeetingAudio(store as never, { maxAgeDays: 30 });
    expect(r.skipped_not_due).toBe(1);
    expect(r.purged).toBe(0);
    expect(fs.existsSync(fresh.wavPath)).toBe(true);
  });

  it('respects nowMs override (deterministic test clock)', () => {
    const m = seedMeeting({ ageDays: 10 });
    const ended = db.getBrainstorm(m.id)?.ended_ms ?? 0;
    const future = ended + 31 * DAY_MS;
    const r = purgeMeetingAudio(store as never, {
      maxAgeDays: 30,
      nowMs: future,
    });
    expect(r.purged).toBe(1);
    expect(fs.existsSync(m.wavPath)).toBe(false);
  });
});
