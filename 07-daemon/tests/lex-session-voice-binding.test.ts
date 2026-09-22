/**
 * Migration 054 (voice layers, 2026-09-21): the Layer 1 voice-brain
 * binding is persisted on the brainstorm anchor (lex_session) so a
 * daemon restart, the dashboard and the Stream Deck can find the L1
 * session the same way project_session carries the worker binding.
 * Plus the cc-session -> anchor lookup the plan-approval detector uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore } from '../src/lex/brainstorm-store.js';
import { appendTranscriptRef } from '../src/lex/lex-session-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

const ANCHOR = 'voice-binding-anchor';
const CC = 'cccccccc-1111-2222-3333-444444444444';

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-voice-binding-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  setStore({ db });
  db.insertLexSession({
    id: ANCHOR,
    created_ms: 1,
    title: null,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/voice-binding',
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

describe('lex_session voice binding (migration 054)', () => {
  it('persists and reads back the L1 binding', () => {
    expect(db.getLexSession(ANCHOR)?.voice_session_id ?? null).toBeNull();
    db.setLexSessionVoiceBinding(ANCHOR, {
      voice_session_id: 'vs-1',
      voice_pty_id: 'vp-1',
      voice_spawned_ms: 123,
    });
    const row = db.getLexSession(ANCHOR)!;
    expect(row.voice_session_id).toBe('vs-1');
    expect(row.voice_pty_id).toBe('vp-1');
    expect(row.voice_spawned_ms).toBe(123);
    db.setLexSessionVoiceBinding(ANCHOR, {
      voice_session_id: null,
      voice_pty_id: null,
      voice_spawned_ms: null,
    });
    expect(db.getLexSession(ANCHOR)!.voice_pty_id).toBeNull();
  });

  it('resolves an anchor by its cc session id through lex_transcript_ref', () => {
    appendTranscriptRef({
      lexSessionId: ANCHOR,
      ccSessionId: CC,
      transcriptPath: 'C:/t.jsonl',
      startedMs: 5,
    });
    expect(db.getLexSessionByCcSessionId(CC)?.id).toBe(ANCHOR);
    expect(db.getLexSessionByCcSessionId('nope')).toBeNull();
  });
});
