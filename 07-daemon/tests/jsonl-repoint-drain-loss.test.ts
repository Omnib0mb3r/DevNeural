/**
 * Fix 2026-05-25 - brainstorm jsonl repoint can drop trailing
 * turns of old CC session.
 *
 * Bug doc: docs/bugs/2026-05-25-jsonl-repoint-drain-loss.md.
 *
 * Two changes under test:
 *   1. brainstorm-store.bindBrainstormSessionId runs one synchronous
 *      ingestor tick BEFORE flipping claude_session_id, draining
 *      any unread turns of the OLD jsonl into brainstorm_chunks
 *      with the OLD cc_session_id stamped per line.
 *   2. brainstorm-jsonl-ingestor offsets map keyed by
 *      `${rowId}:${claude_session_id}` so a repoint starts at
 *      offset 0 cleanly on the new jsonl instead of seeking with
 *      the old jsonl's tail offset.
 *
 * Three contract scenarios from the bug doc Section "Contract
 * tests".
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
  runBrainstormJsonlIngestTick,
} from '../src/lex/brainstorm-jsonl-ingestor.js';
import {
  bindBrainstormSessionId,
  setStore,
} from '../src/lex/brainstorm-store.js';
/* Store import omitted: Store.open opens its own IndexDb keyed off
 * DATA_ROOT which is captured at module import (paths.ts:4), so a
 * test-time env flip can't redirect it to tmpDir. The
 * setStore-compatible shape only needs `.db`. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let oldJsonl: string;
let newJsonl: string;
let priors: {
  DEVNEURAL_DATA_ROOT?: string;
  DEVNEURAL_PROJECTS_ROOT?: string;
  HOME?: string;
  USERPROFILE?: string;
};

const BS_ID = 'bs-repoint-test';
const OLD_CC = '11111111-1111-1111-1111-111111111111';
const NEW_CC = '22222222-2222-2222-2222-222222222222';
const PTY = 'pty-repoint-test';

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

function seedBrainstorm(): void {
  db.insertBrainstorm({
    id: BS_ID,
    claude_session_id: OLD_CC,
    pty_id: PTY,
    cwd: 'C:/dev/data/skill-connections/brainstorm',
    user_label: 'repoint test',
    derived_label: null,
    mode: 'conversation',
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

/* Resolver that returns the per-cc jsonl file path based on the
 * row's CURRENT claude_session_id. Mirrors production's
 * defaultResolveJsonlPath behavior (looks up jsonl by cc id) without
 * touching ~/.claude/projects. */
function resolveJsonlPath(row: { claude_session_id: string | null }): string | null {
  if (row.claude_session_id === OLD_CC) return oldJsonl;
  if (row.claude_session_id === NEW_CC) return newJsonl;
  return null;
}

function deps() {
  return {
    db,
    listActiveBrainstorms: () =>
      db.listBrainstorms({ status: 'active' as const, limit: 10 }),
    resolveJsonlPath,
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-repoint-'));
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'EmptyProjectsRoot'), { recursive: true });
  priors = {
    DEVNEURAL_DATA_ROOT: process.env.DEVNEURAL_DATA_ROOT,
    DEVNEURAL_PROJECTS_ROOT: process.env.DEVNEURAL_PROJECTS_ROOT,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'EmptyProjectsRoot');
  process.env.HOME = path.join(tmpDir, 'home');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  /* Minimal store-shaped facade so setStore is satisfied without
   * pulling in the real Store (which captures DATA_ROOT at import
   * and would open a different file than our tmpDir-scoped one). */
  setStore({ db } as unknown as Parameters<typeof setStore>[0]);
  _resetBrainstormOffsetsForTests();
  oldJsonl = path.join(tmpDir, 'old.jsonl');
  newJsonl = path.join(tmpDir, 'new.jsonl');
  fs.writeFileSync(oldJsonl, '', 'utf-8');
  fs.writeFileSync(newJsonl, '', 'utf-8');
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  for (const [k, v] of Object.entries(priors)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* Windows holds sqlite briefly; OS reclaims. */
  }
  _resetBrainstormOffsetsForTests();
});

describe('Fix 2026-05-25: jsonl repoint scenarios', () => {
  it('repoint: 3 old turns + 2 new turns => 5 chunks total, correct cc_session_id per row', () => {
    seedBrainstorm();
    /* Write 3 turns into the OLD jsonl. */
    fs.writeFileSync(
      oldJsonl,
      jsonlLine({
        type: 'user',
        uuid: 'old-u-1',
        sessionId: OLD_CC,
        message: { content: 'old user 1' },
      }) +
        jsonlLine({
          type: 'assistant',
          uuid: 'old-a-1',
          sessionId: OLD_CC,
          message: { content: 'old lex 1' },
        }) +
        jsonlLine({
          type: 'user',
          uuid: 'old-u-2',
          sessionId: OLD_CC,
          message: { content: 'old user 2' },
        }),
      'utf-8',
    );
    let r = runBrainstormJsonlIngestTick(deps());
    expect(r.inserted).toBe(3);
    /* Flip claude_session_id to NEW_CC. The bind helper drains any
     * unread old turns first (none here; we just ingested) and
     * then updates the row. */
    bindBrainstormSessionId(BS_ID, PTY, NEW_CC);
    /* Write 2 turns into the NEW jsonl. */
    fs.writeFileSync(
      newJsonl,
      jsonlLine({
        type: 'user',
        uuid: 'new-u-1',
        sessionId: NEW_CC,
        message: { content: 'new user 1' },
      }) +
        jsonlLine({
          type: 'assistant',
          uuid: 'new-a-1',
          sessionId: NEW_CC,
          message: { content: 'new lex 1' },
        }),
      'utf-8',
    );
    r = runBrainstormJsonlIngestTick(deps());
    expect(r.inserted).toBe(2);
    const rows = db.listBrainstormChunks(BS_ID, 100);
    expect(rows.length).toBe(5);
    const byOldCc = rows.filter((row) => row.cc_session_id === OLD_CC);
    const byNewCc = rows.filter((row) => row.cc_session_id === NEW_CC);
    expect(byOldCc.length).toBe(3);
    expect(byNewCc.length).toBe(2);
  });

  it('stale-offset: 10 old turns ingested, repoint to a 4-turn new jsonl, all 4 new turns land', () => {
    seedBrainstorm();
    /* 10 old turns; padded to give the OLD jsonl a substantial
     * byte size larger than the NEW jsonl will be. Without the
     * composite key fix, the post-repoint tick would seek into the
     * new jsonl at the old jsonl's tail offset and skip every
     * line. */
    let oldText = '';
    for (let i = 0; i < 10; i += 1) {
      oldText += jsonlLine({
        type: i % 2 === 0 ? 'user' : 'assistant',
        uuid: `old-${i}`,
        sessionId: OLD_CC,
        message: { content: `old turn ${i} ` + 'x'.repeat(200) },
      });
    }
    fs.writeFileSync(oldJsonl, oldText, 'utf-8');
    let r = runBrainstormJsonlIngestTick(deps());
    expect(r.inserted).toBe(10);
    /* Pointer flips. The drain on the old jsonl finds no unread
     * bytes since the prior tick consumed them all. */
    bindBrainstormSessionId(BS_ID, PTY, NEW_CC);
    /* Fresh NEW jsonl with 4 turns. Total bytes deliberately
     * smaller than the OLD jsonl's byte size so a stale-offset
     * read would return empty. */
    fs.writeFileSync(
      newJsonl,
      jsonlLine({
        type: 'user',
        uuid: 'new-u-1',
        sessionId: NEW_CC,
        message: { content: 'a' },
      }) +
        jsonlLine({
          type: 'assistant',
          uuid: 'new-a-1',
          sessionId: NEW_CC,
          message: { content: 'b' },
        }) +
        jsonlLine({
          type: 'user',
          uuid: 'new-u-2',
          sessionId: NEW_CC,
          message: { content: 'c' },
        }) +
        jsonlLine({
          type: 'assistant',
          uuid: 'new-a-2',
          sessionId: NEW_CC,
          message: { content: 'd' },
        }),
      'utf-8',
    );
    r = runBrainstormJsonlIngestTick(deps());
    expect(r.inserted).toBe(4);
    const newRows = db
      .listBrainstormChunks(BS_ID, 100)
      .filter((row) => row.cc_session_id === NEW_CC);
    expect(newRows.length).toBe(4);
    expect(newRows.map((row) => row.id).sort()).toEqual([
      'new-a-1',
      'new-a-2',
      'new-u-1',
      'new-u-2',
    ]);
  });

  it('drain-on-repoint: trailing turn appended to old jsonl with no tick lands during bindBrainstormSessionId', () => {
    seedBrainstorm();
    /* Write 1 turn, ingest. */
    fs.writeFileSync(
      oldJsonl,
      jsonlLine({
        type: 'user',
        uuid: 'old-u-1',
        sessionId: OLD_CC,
        message: { content: 'consumed' },
      }),
      'utf-8',
    );
    runBrainstormJsonlIngestTick(deps());
    /* Append a trailing turn. Do NOT run a tick - simulate the
     * race window where claude wrote one more line between the
     * cron-cadence ingest tick and the repoint that fires when
     * a /clear or --resume reject mints a new cc id. */
    fs.appendFileSync(
      oldJsonl,
      jsonlLine({
        type: 'assistant',
        uuid: 'old-a-trailing',
        sessionId: OLD_CC,
        message: { content: 'this would have been lost without the drain' },
      }),
      'utf-8',
    );
    /* bindBrainstormSessionId MUST drain the old jsonl first. We
     * inject a custom resolver via dependency-monkey-patching the
     * module's default; production calls bindBrainstormSessionId
     * with no deps and gets the default ~/.claude/projects
     * resolver. For this test we pre-seed the offsets so the drain
     * walks oldJsonl directly via the default resolver. To make
     * the default resolver see our test jsonl, drop a symlink-ish
     * file under the fake HOME projects dir. */
    const ccDir = path.join(
      tmpDir,
      'home',
      '.claude',
      'projects',
      'fake-slug',
    );
    fs.mkdirSync(ccDir, { recursive: true });
    const oldHomePath = path.join(ccDir, `${OLD_CC}.jsonl`);
    /* Copy the test's oldJsonl contents into the HOME path the
     * default resolver scans. The drain inside bindBrainstormSessionId
     * uses runBrainstormJsonlIngestTick with deps unset, so it
     * reaches for defaultResolveJsonlPath. */
    fs.copyFileSync(oldJsonl, oldHomePath);
    bindBrainstormSessionId(BS_ID, PTY, NEW_CC);
    const trailing = db
      .listBrainstormChunks(BS_ID, 100)
      .find((row) => row.id === 'old-a-trailing');
    expect(trailing).toBeDefined();
    expect(trailing?.cc_session_id).toBe(OLD_CC);
    expect(trailing?.role).toBe('lex');
  });
});
