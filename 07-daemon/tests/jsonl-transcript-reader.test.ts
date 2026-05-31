/**
 * Fallback transcript reader tests.
 *
 * Exercises readTranscriptFromJsonlRefs + hasDistillableJsonlSource
 * against synthetic CC jsonl files and lex_transcript_ref rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  hasDistillableJsonlSource,
  readTranscriptFromJsonlRefs,
} from '../src/lex/jsonl-transcript-reader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
const BS_ID = 'bs-jsonl-fallback';

async function migrate(dbFile: string): Promise<void> {
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-jsonl-read-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  await migrate(dbFile);
  db = new IndexDb(dbFile);
  /* lex_session row is required for the FK on lex_transcript_ref. */
  db.insertLexSession({
    id: BS_ID,
    created_ms: 1_000,
    title: null,
    derived_title: null,
    status: 'dormant',
    current_pty_id: null,
    cwd: 'C:/p',
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: object[]): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return p;
}

function insertRef(opts: {
  cc: string;
  ordering: number;
  jsonlPath: string;
  startedMs: number;
}): void {
  db.insertLexTranscriptRef({
    lex_session_id: BS_ID,
    cc_session_id: opts.cc,
    transcript_path: opts.jsonlPath,
    started_ms: opts.startedMs,
    ended_ms: opts.startedMs + 10,
    ordering: opts.ordering,
  });
}

describe('readTranscriptFromJsonlRefs', () => {
  it('returns empty string when the brainstorm has zero refs', () => {
    expect(readTranscriptFromJsonlRefs(db, BS_ID)).toBe('');
  });

  it('reads user and assistant turns from a single ref and formats ROLE: text per line', () => {
    const p = writeJsonl('one.jsonl', [
      {
        type: 'user',
        message: { role: 'user', content: 'hello there' },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi back' }],
        },
      },
    ]);
    insertRef({ cc: 'cc-a', ordering: 0, jsonlPath: p, startedMs: 1 });
    const out = readTranscriptFromJsonlRefs(db, BS_ID);
    expect(out).toBe('USER: hello there\nLEX: hi back');
  });

  it('skips sidechain entries, malformed JSON, and tool_use parts', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'keep' },
      }),
      'not valid json {',
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'dropped' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'x', name: 'bash', input: {} },
            { type: 'text', text: 'kept' },
          ],
        },
      }),
    ];
    const p = path.join(tmpDir, 'mixed.jsonl');
    fs.writeFileSync(p, lines.join('\n'), 'utf-8');
    insertRef({ cc: 'cc-b', ordering: 0, jsonlPath: p, startedMs: 1 });
    const out = readTranscriptFromJsonlRefs(db, BS_ID);
    expect(out).toBe('USER: keep\nLEX: kept');
  });

  it('concatenates refs in ordering ascending', () => {
    const p1 = writeJsonl('a.jsonl', [
      { type: 'user', message: { role: 'user', content: 'first' } },
    ]);
    const p2 = writeJsonl('b.jsonl', [
      { type: 'user', message: { role: 'user', content: 'second' } },
    ]);
    insertRef({ cc: 'cc-2', ordering: 1, jsonlPath: p2, startedMs: 20 });
    insertRef({ cc: 'cc-1', ordering: 0, jsonlPath: p1, startedMs: 10 });
    const out = readTranscriptFromJsonlRefs(db, BS_ID);
    expect(out).toBe('USER: first\nUSER: second');
  });

  it('tail-trims to maxBytes so the newest content survives', () => {
    const p = writeJsonl('big.jsonl', [
      { type: 'user', message: { role: 'user', content: 'AAAAAAAAAAAAAAAA' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'BBBBBBBBBB' }] } },
      { type: 'user', message: { role: 'user', content: 'newest' } },
    ]);
    insertRef({ cc: 'cc-c', ordering: 0, jsonlPath: p, startedMs: 1 });
    const out = readTranscriptFromJsonlRefs(db, BS_ID, { maxBytes: 20 });
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('USER: newest')).toBe(true);
  });

  it('skips refs whose transcript_path does not exist on disk', () => {
    const p = writeJsonl('exists.jsonl', [
      { type: 'user', message: { role: 'user', content: 'kept' } },
    ]);
    insertRef({ cc: 'cc-missing', ordering: 0, jsonlPath: path.join(tmpDir, 'gone.jsonl'), startedMs: 1 });
    insertRef({ cc: 'cc-here', ordering: 1, jsonlPath: p, startedMs: 2 });
    const out = readTranscriptFromJsonlRefs(db, BS_ID);
    expect(out).toBe('USER: kept');
  });
});

describe('hasDistillableJsonlSource', () => {
  it('returns false when no refs exist', () => {
    expect(hasDistillableJsonlSource(db, BS_ID)).toBe(false);
  });

  it('returns true when at least one ref points to an existing file', () => {
    const p = writeJsonl('h.jsonl', [
      { type: 'user', message: { role: 'user', content: 'x' } },
    ]);
    insertRef({ cc: 'cc-h', ordering: 0, jsonlPath: p, startedMs: 1 });
    expect(hasDistillableJsonlSource(db, BS_ID)).toBe(true);
  });

  it('returns false when refs exist but all transcript_paths are missing', () => {
    insertRef({
      cc: 'cc-ghost',
      ordering: 0,
      jsonlPath: path.join(tmpDir, 'nope.jsonl'),
      startedMs: 1,
    });
    expect(hasDistillableJsonlSource(db, BS_ID)).toBe(false);
  });
});
