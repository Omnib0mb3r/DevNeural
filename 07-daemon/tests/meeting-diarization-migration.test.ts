/**
 * Migration 050 (meeting_diarization table, 2026-07-15). Verifies the
 * migration runner creates the table with the expected shape and that
 * the IndexDb insert/list helpers round-trip through it. See
 * scripts/migrations/050-meeting-diarization.sql and
 * src/lex/meeting-diarize.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-diarize-mig-'));
  dbFile = path.join(tmpDir, 'index.db');
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedMeeting(): string {
  const id = randomUUID();
  db.insertBrainstorm({
    id,
    claude_session_id: null,
    pty_id: null,
    cwd: '/tmp/brainstorm',
    user_label: null,
    derived_label: null,
    mode: 'notes',
    status: 'ended',
    started_ms: Date.now() - 60_000,
    ended_ms: Date.now(),
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
  db.setBrainstormPhaseTwo(id, { kind: 'meeting', consent_acked: 1 });
  return id;
}

describe('migration 050: meeting_diarization', () => {
  it('is applied by the migration runner exactly once (idempotent)', async () => {
    const r1 = await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
    expect(r1.applied).not.toContain('050-meeting-diarization.sql');
    expect(r1.skipped).toContain('050-meeting-diarization.sql');
  });

  it('creates the table with the expected columns', () => {
    const raw = new Database(dbFile);
    try {
      const tables = raw
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toContain('meeting_diarization');

      const cols = raw
        .prepare(`PRAGMA table_info(meeting_diarization)`)
        .all() as { name: string }[];
      const colNames = cols.map((c) => c.name);
      for (const c of [
        'id',
        'session_id',
        'start_ms',
        'end_ms',
        'speaker',
        'speaker_guess',
        'text',
        'created_at',
      ]) {
        expect(colNames).toContain(c);
      }
    } finally {
      raw.close();
    }
  });

  it('rejects a segment insert for a session_id with no matching brainstorm_sessions row (FK enforced)', () => {
    expect(() =>
      db.insertMeetingDiarizationSegments([
        {
          id: randomUUID(),
          session_id: randomUUID(),
          start_ms: 0,
          end_ms: 1000,
          speaker: 'SPEAKER_00',
          speaker_guess: null,
          text: 'orphan segment',
        },
      ]),
    ).toThrow(/FOREIGN KEY/);
  });

  it('round-trips insertMeetingDiarizationSegments / listMeetingDiarization ordered by start_ms', () => {
    const sessionId = seedMeeting();
    const stored = db.insertMeetingDiarizationSegments([
      {
        id: randomUUID(),
        session_id: sessionId,
        start_ms: 5000,
        end_ms: 8000,
        speaker: 'SPEAKER_01',
        speaker_guess: 'Bob',
        text: 'second thing said',
      },
      {
        id: randomUUID(),
        session_id: sessionId,
        start_ms: 0,
        end_ms: 4000,
        speaker: 'SPEAKER_00',
        speaker_guess: 'Alice',
        text: 'first thing said',
      },
    ]);
    expect(stored).toBe(2);

    const rows = db.listMeetingDiarization(sessionId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toBe('first thing said');
    expect(rows[0]!.speaker_guess).toBe('Alice');
    expect(rows[1]!.text).toBe('second thing said');
    expect(rows[1]!.speaker).toBe('SPEAKER_01');
  });

  it('insertMeetingDiarizationSegments is a no-op on an empty array', () => {
    expect(db.insertMeetingDiarizationSegments([])).toBe(0);
  });
});
