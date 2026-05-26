/**
 * LEX-AUTONOMY codex item 7 (Fix 44) integration pin.
 *
 * Cold-start preload renders the pinned ref first even when newer
 * refs exist on the same anchor.
 *
 * Drives the anchor-refs path through `preloadColdStartSiblings` with
 * a synthetic anchor + three refs (one pinned, one fresh, one stale)
 * and asserts the surfaced sibling_count + ref ordering matches the
 * walk-back scorer's pin-pre-pass.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { preloadColdStartSiblings } from '../src/lex/lex-cold-start-preamble.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
const ANCHOR_ID = 'codex7-walkback-anchor';
const CC_PINNED = '00000000-0000-0000-0000-000000000aaa';
const CC_FRESH = '00000000-0000-0000-0000-000000000bbb';
const CC_STALE = '00000000-0000-0000-0000-000000000ccc';
const CC_ACTIVE = '00000000-0000-0000-0000-000000000ddd';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-codex7-cold-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedAnchor(): void {
  db.insertBrainstorm({
    id: ANCHOR_ID,
    claude_session_id: CC_PINNED,
    pty_id: null,
    cwd: 'C:/dev/codex7',
    user_label: 'codex7',
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: 1_000_000,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  } as unknown as Parameters<typeof db.insertBrainstorm>[0]);
  db.insertLexSession({
    id: ANCHOR_ID,
    created_ms: 1_000_000,
    title: null,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/codex7',
  });
}

function seedRef(cc: string, started: number, ordering: number): number {
  const r = db.insertLexTranscriptRef({
    lex_session_id: ANCHOR_ID,
    cc_session_id: cc,
    transcript_path: `/tmp/${cc}.jsonl`,
    started_ms: started,
    ended_ms: started + 1_000,
    ordering,
  });
  return r.id;
}

describe('cold-start preload integration with walk-back (Fix 44)', () => {
  it('renders the pinned ref first even when newer refs exist', async () => {
    seedAnchor();
    /* Three refs in order pinned (oldest), stale (middle), fresh (newest).
     * Without the scorer, newest wins on `ordering DESC`. With the
     * scorer's pin pre-pass, the pinned ref lands first. */
    const pinnedId = seedRef(CC_PINNED, 100, 0);
    const staleId = seedRef(CC_STALE, 200, 1);
    const freshId = seedRef(CC_FRESH, 300, 2);
    /* Mark coverage so non-pinned refs survive the floor. */
    db.updateLexTranscriptRef(pinnedId, {
      ref_summary: 'pinned ref summary',
      ref_summary_ms: 100,
      latest_chunk_ms: 100,
      coverage_score: 0.9,
    });
    db.updateLexTranscriptRef(staleId, {
      ref_summary: 'stale ref summary',
      ref_summary_ms: 200,
      latest_chunk_ms: 200 + 10 * 600_000, // far past staleness threshold
      coverage_score: 0.9,
    });
    db.updateLexTranscriptRef(freshId, {
      ref_summary: 'fresh ref summary',
      ref_summary_ms: 300,
      latest_chunk_ms: 300,
      coverage_score: 0.9,
    });
    /* Flip pin. */
    const ok = db.setLexTranscriptRefPinned(CC_PINNED, true);
    expect(ok).toBe(true);

    const summary = await preloadColdStartSiblings({
      db,
      generator: null,
      label: 'codex7',
      excludeId: ANCHOR_ID,
      anchorId: ANCHOR_ID,
      currentCcSessionId: CC_ACTIVE,
      perSessionGenerator: null,
      now: () => 10_000_000,
      readTranscript: () => null,
    });

    /* Walk-back returned all 3 refs (limit 5 default). The first slot
     * is the pinned ref via the pre-pass. */
    expect(summary.sibling_count).toBe(3);

    /* Spot-check the underlying ordering via a direct walk-back call.
     * The cold-start summary does not return the ordered ref id list
     * today; the integration test asserts the count + a follow-up
     * unit-style assertion via the underlying picker confirms the
     * order. */
    const { pickBundles } = await import('../src/lex/adaptive-walk-back.js');
    const refs = db
      .listLexTranscriptRefs(ANCHOR_ID)
      .filter((r) => r.cc_session_id !== CC_ACTIVE);
    const { selected } = pickBundles(refs, {
      now: 10_000_000,
      limit: 5,
    });
    expect(selected[0]!.ref.cc_session_id).toBe(CC_PINNED);
    expect(selected[0]!.reason).toBe('pinned');
  });

  it('failure-laden ref drops behind a clean ref of equal recency', async () => {
    seedAnchor();
    const flakyId = seedRef(CC_STALE, 200, 0);
    const cleanId = seedRef(CC_FRESH, 200, 1); // same started_ms
    db.updateLexTranscriptRef(flakyId, {
      ref_summary: 'flaky',
      ref_summary_ms: 200,
      latest_chunk_ms: 200,
      coverage_score: 0.9,
    });
    db.updateLexTranscriptRef(cleanId, {
      ref_summary: 'clean',
      ref_summary_ms: 200,
      latest_chunk_ms: 200,
      coverage_score: 0.9,
    });
    /* Seed five recent provider_threw rows under the flaky cc; the
     * scorer reads listRecentDistillationErrors so we have to write
     * matching rows. */
    for (let i = 0; i < 5; i++) {
      db.insertDistillationError({
        id: `e${i}`,
        brainstorm_id: ANCHOR_ID,
        cc_session_id: CC_STALE,
        generator: 'per-session',
        error_class: 'provider_threw',
        error_message: 'synthetic',
      });
    }

    const { pickBundles, buildRecentErrorMap } = await import(
      '../src/lex/adaptive-walk-back.js'
    );
    const refs = db.listLexTranscriptRefs(ANCHOR_ID);
    const errorMap = buildRecentErrorMap(
      db.listRecentDistillationErrors(200, { brainstormId: ANCHOR_ID }),
    );
    const { selected } = pickBundles(refs, {
      now: 10_000_000,
      limit: 5,
      recentErrorCountByCc: errorMap,
    });
    expect(selected[0]!.ref.cc_session_id).toBe(CC_FRESH);
  });
});
