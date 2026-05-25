/* Brainstorm jsonl ingestor. Pins the contracts:
 *   1. Walks the CC jsonl and inserts brainstorm_chunks for every
 *      user + assistant turn it sees.
 *   2. Idempotent across ticks: the same jsonl line yields one row
 *      via INSERT OR REPLACE on the cc turn uuid.
 *   3. Resumes from the per-session byte offset on the next tick.
 *   4. Ignores meta/compact-summary entries and tool-only assistant
 *      turns with no text payload.
 *   5. Speaker tagging maps entry.type='assistant' to role='lex'
 *      and entry.type='user' to role='user'.
 *   6. Mode normalises off brainstorm row; unrecognised modes fall
 *      back to 'conversation'.
 *
 * Uses tmp DB to isolate from production state. The jsonl read is
 * stubbed via deps so the test never depends on ~/.claude/projects.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  _resetBrainstormOffsetsForTests,
  _peekBrainstormOffsetsForTests,
  runBrainstormJsonlIngestTick,
} from '../src/lex/brainstorm-jsonl-ingestor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let jsonlFile: string;

const BS_ID = 'test-brainstorm-1';
const CC_SESSION = '11111111-2222-3333-4444-555555555555';

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

function seedBrainstorm(mode: string = 'conversation'): void {
  db.insertBrainstorm({
    id: BS_ID,
    claude_session_id: CC_SESSION,
    pty_id: 'pty-1',
    cwd: 'C:/dev/data/skill-connections/brainstorm',
    user_label: null,
    derived_label: null,
    mode,
    status: 'active',
    started_ms: Date.now(),
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  } as unknown as Parameters<typeof db.insertBrainstorm>[0]);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-bs-ingest-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  _resetBrainstormOffsetsForTests();
  jsonlFile = path.join(tmpDir, 'session.jsonl');
  fs.writeFileSync(jsonlFile, '', 'utf-8');
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  _resetBrainstormOffsetsForTests();
});

function deps() {
  return {
    db,
    listActiveBrainstorms: () => db.listBrainstorms({ status: 'active' as const, limit: 10 }),
    resolveJsonlPath: () => jsonlFile,
  };
}

describe('runBrainstormJsonlIngestTick', () => {
  it('inserts user + assistant turns from the CC jsonl with role + uuid id', () => {
    seedBrainstorm();
    fs.writeFileSync(
      jsonlFile,
      jsonlLine({
        type: 'user',
        uuid: 'u-1',
        message: { role: 'user', content: 'hello lex' },
      }) +
        jsonlLine({
          type: 'assistant',
          uuid: 'a-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi michael' }] },
        }),
      'utf-8',
    );
    const r = runBrainstormJsonlIngestTick(deps());
    expect(r.scanned).toBe(1);
    expect(r.inserted).toBe(2);
    const rows = db.listBrainstormChunks(BS_ID, 100);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ id: 'u-1', role: 'user', text: 'hello lex' });
    expect(rows[1]).toMatchObject({ id: 'a-1', role: 'lex', text: 'hi michael' });
  });

  it('is idempotent: re-walking the same content does not duplicate rows', () => {
    seedBrainstorm();
    fs.writeFileSync(
      jsonlFile,
      jsonlLine({ type: 'user', uuid: 'u-1', message: { content: 'one' } }),
      'utf-8',
    );
    runBrainstormJsonlIngestTick(deps());
    /* Reset the offset map to force a re-walk of the entire file.
     * INSERT OR REPLACE on the cc turn uuid must keep the chunk
     * count at 1. */
    _resetBrainstormOffsetsForTests();
    runBrainstormJsonlIngestTick(deps());
    expect(db.listBrainstormChunks(BS_ID, 100).length).toBe(1);
  });

  it('resumes from the per-session byte offset on the next tick', () => {
    seedBrainstorm();
    fs.writeFileSync(
      jsonlFile,
      jsonlLine({ type: 'user', uuid: 'u-1', message: { content: 'first' } }),
      'utf-8',
    );
    runBrainstormJsonlIngestTick(deps());
    /* Fix 2026-05-25: offsets map is keyed by
     * `${rowId}:${claude_session_id}` (composite) so a jsonl
     * repoint starts at offset 0 cleanly. */
    const firstOffset = _peekBrainstormOffsetsForTests().get(
      `${BS_ID}:${CC_SESSION}`,
    );
    expect(firstOffset).toBeGreaterThan(0);
    /* Append a second turn. Tick should pick up only the new line. */
    fs.appendFileSync(
      jsonlFile,
      jsonlLine({ type: 'assistant', uuid: 'a-1', message: { content: 'second' } }),
      'utf-8',
    );
    const r = runBrainstormJsonlIngestTick(deps());
    expect(r.inserted).toBe(1);
    const rows = db.listBrainstormChunks(BS_ID, 100);
    expect(rows.length).toBe(2);
  });

  it('skips meta / compact-summary entries and tool-only assistant turns', () => {
    seedBrainstorm();
    fs.writeFileSync(
      jsonlFile,
      jsonlLine({ type: 'user', uuid: 'meta-1', isMeta: true, message: { content: 'ignore me' } }) +
        jsonlLine({
          type: 'assistant',
          uuid: 'compact-1',
          isCompactSummary: true,
          message: { content: 'summary' },
        }) +
        jsonlLine({
          type: 'assistant',
          uuid: 'tool-only-1',
          message: {
            content: [{ type: 'tool_use', text: undefined }],
          },
        }) +
        jsonlLine({
          type: 'user',
          uuid: 'real-1',
          message: { content: 'a real turn' },
        }),
      'utf-8',
    );
    const r = runBrainstormJsonlIngestTick(deps());
    expect(r.inserted).toBe(1);
    const rows = db.listBrainstormChunks(BS_ID, 100);
    expect(rows.map((r) => r.id)).toEqual(['real-1']);
  });

  it('normalises unrecognised mode strings to conversation', () => {
    seedBrainstorm('garbage-mode');
    fs.writeFileSync(
      jsonlFile,
      jsonlLine({ type: 'user', uuid: 'u-1', message: { content: 'hi' } }),
      'utf-8',
    );
    runBrainstormJsonlIngestTick(deps());
    const rows = db.listBrainstormChunks(BS_ID, 10);
    expect(rows[0]?.mode).toBe('conversation');
  });

  it('preserves explicit mode tags (notes, push-to-talk)', () => {
    seedBrainstorm('notes');
    fs.writeFileSync(
      jsonlFile,
      jsonlLine({ type: 'user', uuid: 'u-1', message: { content: 'note' } }),
      'utf-8',
    );
    runBrainstormJsonlIngestTick(deps());
    const rows = db.listBrainstormChunks(BS_ID, 10);
    expect(rows[0]?.mode).toBe('notes');
  });

  it('preserves jsonl order across mixed user + assistant turns', () => {
    seedBrainstorm();
    fs.writeFileSync(
      jsonlFile,
      jsonlLine({ type: 'user', uuid: 'u-1', message: { content: 'one' } }) +
        jsonlLine({ type: 'assistant', uuid: 'a-1', message: { content: 'two' } }) +
        jsonlLine({ type: 'user', uuid: 'u-2', message: { content: 'three' } }) +
        jsonlLine({ type: 'assistant', uuid: 'a-2', message: { content: 'four' } }),
      'utf-8',
    );
    runBrainstormJsonlIngestTick(deps());
    const rows = db.listBrainstormChunks(BS_ID, 10);
    expect(rows.map((r) => r.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(rows.map((r) => r.role)).toEqual(['user', 'lex', 'user', 'lex']);
  });

  /* Stage 1 capture invariant (LEX-AUTONOMY-PAYLOAD-SPEC + bug
   * 2026-05-24). Attachment is additive, never a gate. Lex's own
   * chunks MUST land regardless of whether a worker is bound to the
   * brainstorm. The bug repro was: end an attached session, find that
   * brainstorm_chunks has zero role='lex' rows, see cold-start
   * preload pick a stale pre-attach sibling. Asserting parity between
   * the attached and unattached writes pins the invariant. If a
   * future change re-introduces a gate, both halves of this test
   * (the attached one specifically) will go red. */
  it("attaches a worker to the brainstorm and still ingests every Lex turn (capture invariant)", () => {
    seedBrainstorm();
    db.updateBrainstorm(BS_ID, {
      attached_worker_session_id: '99999999-aaaa-bbbb-cccc-dddddddddddd',
      lifecycle_state: 'attached',
    } as Partial<Parameters<typeof db.updateBrainstorm>[1]>);
    /* Sanity: the attached marker actually landed; if updateBrainstorm
     * silently swallows the field this whole test is vacuous. */
    const post = db.getBrainstorm(BS_ID);
    expect(post?.attached_worker_session_id).toBe(
      '99999999-aaaa-bbbb-cccc-dddddddddddd',
    );
    fs.writeFileSync(
      jsonlFile,
      jsonlLine({
        type: 'assistant',
        uuid: 'lex-1',
        sessionId: CC_SESSION,
        message: { content: [{ type: 'text', text: 'lex turn one' }] },
      }) +
        jsonlLine({
          type: 'user',
          uuid: 'user-1',
          sessionId: CC_SESSION,
          message: { content: 'user reply' },
        }) +
        jsonlLine({
          type: 'assistant',
          uuid: 'lex-2',
          sessionId: CC_SESSION,
          message: { content: [{ type: 'text', text: 'lex turn two' }] },
        }) +
        jsonlLine({
          type: 'assistant',
          uuid: 'lex-3',
          sessionId: CC_SESSION,
          message: { content: [{ type: 'text', text: 'lex turn three' }] },
        }),
      'utf-8',
    );
    const r = runBrainstormJsonlIngestTick(deps());
    expect(r.inserted).toBe(4);
    const rows = db.listBrainstormChunks(BS_ID, 100);
    const lexRows = rows.filter((row) => row.role === 'lex');
    expect(lexRows.length).toBe(3);
    expect(lexRows.map((row) => row.id)).toEqual(['lex-1', 'lex-2', 'lex-3']);
    /* Stage 0 stamping must travel through alongside the invariant:
     * the originating cc_session_id from the jsonl line is on every
     * Lex chunk written under an attached brainstorm. */
    for (const row of lexRows) {
      expect(row.cc_session_id).toBe(CC_SESSION);
    }
  });

  it('rewinds the offset to the last complete line so a partial trailing line is re-read', () => {
    seedBrainstorm();
    /* Write two full lines + a third line missing its trailing
     * newline (still being written). The ingestor must NOT consume
     * the partial line; the next tick after the writer finishes
     * must pick it up cleanly. */
    fs.writeFileSync(
      jsonlFile,
      jsonlLine({ type: 'user', uuid: 'u-1', message: { content: 'a' } }) +
        jsonlLine({ type: 'user', uuid: 'u-2', message: { content: 'b' } }) +
        JSON.stringify({ type: 'user', uuid: 'u-3', message: { content: 'partial' } }),
      'utf-8',
    );
    let r = runBrainstormJsonlIngestTick(deps());
    expect(r.inserted).toBe(2);
    /* Now the writer flushes the trailing newline. */
    fs.appendFileSync(jsonlFile, '\n', 'utf-8');
    r = runBrainstormJsonlIngestTick(deps());
    expect(r.inserted).toBe(1);
    const rows = db.listBrainstormChunks(BS_ID, 10);
    expect(rows.map((r) => r.id)).toEqual(['u-1', 'u-2', 'u-3']);
  });
});
