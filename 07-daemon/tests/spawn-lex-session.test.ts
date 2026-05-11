/**
 * prepareLexSpawn unit tests (PLAN-lex-session-rewrite.md, step 2).
 *
 * Verifies the spawn-prep contract that has to hold before the PTY
 * subprocess starts: a fresh anchor gets a row, a transcript ref is
 * appended at the right ordering, the transcript path matches the
 * Claude Code slug convention, and the args fragment carries
 * --session-id <uuid>. Reopen reuses the anchor and bumps ordering.
 *
 * Does NOT touch pty-host.spawnLex (the actual PTY runner is mocked
 * out by simply not calling spawnLexSession).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { setStore } from '../src/lex/brainstorm-store.js';
import {
  prepareLexSpawn,
  cwdToClaudeSlug,
  transcriptPathFor,
} from '../src/lex/spawn-lex-session.js';
import { listTranscriptRefs } from '../src/lex/lex-session-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;
const FAKE_HOME = 'C:/Users/fake';
const CWD = 'C:/dev/data/skill-connections/brainstorm';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-spawn-lex-'));
  dbFile = path.join(tmpDir, 'index.db');
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  /* IndexDb constructor creates legacy tables; runMigrations creates
   * lex_session + lex_transcript_ref via 018-*. */
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

describe('cwdToClaudeSlug', () => {
  it('replaces colons and slashes with dashes (windows paths)', () => {
    expect(cwdToClaudeSlug('C:/dev/data/skill-connections/brainstorm')).toBe(
      'C--dev-data-skill-connections-brainstorm',
    );
    expect(cwdToClaudeSlug('C:\\dev\\data\\skill-connections\\brainstorm')).toBe(
      'C--dev-data-skill-connections-brainstorm',
    );
  });
});

describe('transcriptPathFor', () => {
  it('renders ~/.claude/projects/<slug>/<cc>.jsonl', () => {
    const p = transcriptPathFor({
      cwd: CWD,
      ccSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      homeDir: FAKE_HOME,
    });
    expect(p).toBe(
      'C:/Users/fake/.claude/projects/C--dev-data-skill-connections-brainstorm/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl',
    );
  });
});

describe('prepareLexSpawn (new anchor)', () => {
  it('inserts a lex_session row and one transcript ref at ordering 0', () => {
    const r = prepareLexSpawn({
      cwd: CWD,
      homeDir: FAKE_HOME,
      ccSessionId: '11111111-1111-1111-1111-111111111111',
      nowMs: 1_700_000_000_000,
    });
    expect(r.isReopen).toBe(false);
    expect(r.ccSessionId).toBe('11111111-1111-1111-1111-111111111111');
    expect(r.lexSession.cwd).toBe(CWD);
    expect(r.lexSession.status).toBe('dormant');
    expect(r.transcriptRef.ordering).toBe(0);
    expect(r.transcriptRef.cc_session_id).toBe(r.ccSessionId);
    expect(r.transcriptPath).toContain('11111111-1111-1111-1111-111111111111.jsonl');

    /* The ref MUST be persisted before prepareLexSpawn returns. */
    const refs = listTranscriptRefs(r.lexSession.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.cc_session_id).toBe(r.ccSessionId);
    expect(refs[0]?.transcript_path).toBe(r.transcriptPath);
  });

  it('emits --session-id <uuid> in the args fragment', () => {
    const r = prepareLexSpawn({
      cwd: CWD,
      ccSessionId: '22222222-2222-2222-2222-222222222222',
      homeDir: FAKE_HOME,
    });
    expect(r.args).toEqual([
      '--session-id',
      '22222222-2222-2222-2222-222222222222',
    ]);
  });

  it('throws if cwd is missing on a fresh anchor', () => {
    expect(() => prepareLexSpawn({})).toThrow(/cwd is required/);
  });
});

describe('prepareLexSpawn (reopen)', () => {
  it('reuses the anchor, appends a new transcript ref at ordering 1', () => {
    const first = prepareLexSpawn({
      cwd: CWD,
      ccSessionId: '33333333-3333-3333-3333-333333333333',
      homeDir: FAKE_HOME,
    });
    const second = prepareLexSpawn({
      lexSessionId: first.lexSession.id,
      ccSessionId: '44444444-4444-4444-4444-444444444444',
      homeDir: FAKE_HOME,
    });

    expect(second.isReopen).toBe(true);
    expect(second.lexSession.id).toBe(first.lexSession.id);
    expect(second.ccSessionId).toBe('44444444-4444-4444-4444-444444444444');
    expect(second.transcriptRef.ordering).toBe(1);

    const refs = listTranscriptRefs(first.lexSession.id);
    expect(refs.map((r) => r.cc_session_id)).toEqual([
      '33333333-3333-3333-3333-333333333333',
      '44444444-4444-4444-4444-444444444444',
    ]);
    expect(refs.map((r) => r.ordering)).toEqual([0, 1]);
  });

  it('throws if lexSessionId is unknown', () => {
    expect(() =>
      prepareLexSpawn({ lexSessionId: 'unknown-id', cwd: CWD }),
    ).toThrow(/lexSessionId not found/);
  });
});

describe('prepareLexSpawn ordering integrity', () => {
  it('keeps ordering monotonically increasing across many reopens', () => {
    const first = prepareLexSpawn({
      cwd: CWD,
      ccSessionId: '00000000-0000-0000-0000-000000000001',
      homeDir: FAKE_HOME,
    });
    for (let i = 2; i <= 5; i += 1) {
      prepareLexSpawn({
        lexSessionId: first.lexSession.id,
        ccSessionId: `00000000-0000-0000-0000-00000000000${i}`,
        homeDir: FAKE_HOME,
      });
    }
    const refs = listTranscriptRefs(first.lexSession.id);
    expect(refs.map((r) => r.ordering)).toEqual([0, 1, 2, 3, 4]);
  });
});
