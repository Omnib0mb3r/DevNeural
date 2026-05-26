/**
 * Codex item 9 (Fix 46) - isFirstAttach + deriveFirstAttachNextAction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  deriveFirstAttachNextAction,
  isFirstAttach,
} from '../src/lex/source-graph-payload.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
const ANCHOR = 'codex9-fa-anchor';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-codex9-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  db.insertBrainstorm({
    id: ANCHOR,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/dev/codex9',
    user_label: 'codex9',
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: 1,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  } as unknown as Parameters<typeof db.insertBrainstorm>[0]);
  db.insertLexSession({
    id: ANCHOR,
    created_ms: 1,
    title: null,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/codex9',
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedRef(): void {
  db.insertLexTranscriptRef({
    lex_session_id: ANCHOR,
    cc_session_id: 'cc-prior',
    transcript_path: '/tmp/cc-prior.jsonl',
    started_ms: 100,
    ended_ms: 200,
    ordering: 0,
  });
}

function seedChunk(role: 'user' | 'lex', text: string, idx = 0): void {
  db.insertBrainstormChunk({
    id: `chunk-${idx}-${role}`,
    brainstorm_id: ANCHOR,
    turn_index: idx,
    role,
    mode: 'conversation',
    text,
    model_id: '',
  });
}

describe('isFirstAttach (Fix 46)', () => {
  it('true when no refs + no chunks', () => {
    expect(isFirstAttach(db, ANCHOR, ANCHOR)).toBe(true);
  });

  it('false when refs exist', () => {
    seedRef();
    expect(isFirstAttach(db, ANCHOR, ANCHOR)).toBe(false);
  });

  it('false when chunks exist (direct-llm edge)', () => {
    seedChunk('user', 'hi');
    expect(isFirstAttach(db, ANCHOR, ANCHOR)).toBe(false);
  });

  it('false when both refs + chunks exist', () => {
    seedRef();
    seedChunk('user', 'hi');
    expect(isFirstAttach(db, ANCHOR, ANCHOR)).toBe(false);
  });
});

describe('deriveFirstAttachNextAction (Fix 46)', () => {
  it('returns last user-role directive when present', () => {
    seedChunk('user', 'noise', 0);
    seedChunk('lex', 'sure', 1);
    seedChunk('user', 'fix the worker boot payload', 2);
    expect(deriveFirstAttachNextAction(db, ANCHOR, ANCHOR)).toBe(
      'fix the worker boot payload',
    );
  });

  it('falls back to anchor.last_summary first line when no directive chunk', () => {
    db.updateBrainstorm(ANCHOR, {
      last_summary: 'Project summary line one\nmore detail',
      last_summary_ms: 100,
    });
    expect(deriveFirstAttachNextAction(db, ANCHOR, ANCHOR)).toBe(
      'Project summary line one',
    );
  });

  it('falls back to anchored default string when no chunk and no summary', () => {
    const out = deriveFirstAttachNextAction(db, ANCHOR, ANCHOR);
    expect(out).toContain('FIRST-ATTACH');
    expect(out).toContain(ANCHOR.slice(0, 8));
  });
});
