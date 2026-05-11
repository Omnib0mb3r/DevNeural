import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-bschunks-'));
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

function seedSession(): string {
  const id = randomUUID();
  db.insertBrainstorm({
    id,
    claude_session_id: null,
    pty_id: null,
    cwd: '/tmp/brainstorm',
    user_label: null,
    derived_label: null,
    mode: 'conversation',
    status: 'ended',
    started_ms: Date.now() - 60_000,
    ended_ms: Date.now(),
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
  return id;
}

describe('listBrainstormChunks (Wave 3 fixup: transcript surface)', () => {
  it('returns chunks ordered by turn_index ascending', () => {
    const bid = seedSession();
    db.insertBrainstormChunk({
      id: randomUUID(),
      brainstorm_id: bid,
      turn_index: 2,
      role: 'lex',
      mode: 'conversation',
      text: 'second',
      model_id: 'opus',
    });
    db.insertBrainstormChunk({
      id: randomUUID(),
      brainstorm_id: bid,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'first',
      model_id: 'opus',
    });
    db.insertBrainstormChunk({
      id: randomUUID(),
      brainstorm_id: bid,
      turn_index: 1,
      role: 'lex',
      mode: 'conversation',
      text: 'middle',
      model_id: 'opus',
    });
    const out = db.listBrainstormChunks(bid);
    expect(out.map((c) => c.text)).toEqual(['first', 'middle', 'second']);
  });

  it('respects the limit argument', () => {
    const bid = seedSession();
    for (let i = 0; i < 5; i++) {
      db.insertBrainstormChunk({
        id: randomUUID(),
        brainstorm_id: bid,
        turn_index: i,
        role: 'user',
        mode: 'conversation',
        text: `t${i}`,
        model_id: 'opus',
      });
    }
    const out = db.listBrainstormChunks(bid, 3);
    expect(out).toHaveLength(3);
    expect(out.map((c) => c.turn_index)).toEqual([0, 1, 2]);
  });

  it('isolates rows by brainstorm_id', () => {
    const bidA = seedSession();
    const bidB = seedSession();
    db.insertBrainstormChunk({
      id: randomUUID(),
      brainstorm_id: bidA,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'a',
      model_id: 'opus',
    });
    db.insertBrainstormChunk({
      id: randomUUID(),
      brainstorm_id: bidB,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'b',
      model_id: 'opus',
    });
    expect(db.listBrainstormChunks(bidA).map((c) => c.text)).toEqual(['a']);
    expect(db.listBrainstormChunks(bidB).map((c) => c.text)).toEqual(['b']);
  });
});
