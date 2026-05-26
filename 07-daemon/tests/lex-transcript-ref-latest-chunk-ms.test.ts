/**
 * LEX-AUTONOMY codex item 5 - write-path + sync-barrier pins.
 *
 * Pins three behaviours:
 *   1. insertBrainstormChunk bumps lex_transcript_ref.latest_chunk_ms
 *      when the chunk has a non-null cc_session_id matching an
 *      existing ref row, and only when the candidate ms strictly
 *      exceeds the current value (monotone guard).
 *   2. preloadColdStartSiblings detects a stale ref on the anchor-refs
 *      path, runs the per-session generator inside the sync budget,
 *      and clears the [stale] tag on success.
 *   3. preloadColdStartSiblings surfaces partial_sync=true when the
 *      per-session generator returns null (e.g. timeout / no provider /
 *      empty reply path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { preloadColdStartSiblings } from '../src/lex/lex-cold-start-preamble.js';
import type { PerSessionDistillationGenerator } from '../src/lex/distillation-generator.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
const ANCHOR_ID = 'brainstorm-stale-test';
const CC_PRIOR = '00000000-0000-0000-0000-000000000aaa';
const CC_ACTIVE = '00000000-0000-0000-0000-000000000bbb';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-codex5-'));
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

function seedBrainstorm(): void {
  db.insertBrainstorm({
    id: ANCHOR_ID,
    claude_session_id: CC_PRIOR,
    pty_id: null,
    cwd: 'C:/dev/codex5-test',
    user_label: 'codex5',
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
  /* lex_session is the durable anchor; id matches brainstorm id by
   * the migration-018 contract. */
  db.insertLexSession({
    id: ANCHOR_ID,
    created_ms: 1,
    title: null,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/codex5-test',
  });
}

function seedPriorRef(): number {
  const ref = db.insertLexTranscriptRef({
    lex_session_id: ANCHOR_ID,
    cc_session_id: CC_PRIOR,
    transcript_path: '/tmp/prior.jsonl',
    started_ms: 100,
    ended_ms: 200,
    ordering: 0,
  });
  return ref.id;
}

describe('insertBrainstormChunk bumps lex_transcript_ref.latest_chunk_ms', () => {
  it('updates the matching ref row when cc_session_id is set', () => {
    seedBrainstorm();
    const refId = seedPriorRef();
    db.insertBrainstormChunk({
      id: 'chunk-1',
      brainstorm_id: ANCHOR_ID,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'hi',
      model_id: '',
      cc_session_id: CC_PRIOR,
    });
    const refs = db.listLexTranscriptRefs(ANCHOR_ID);
    const target = refs.find((r) => r.id === refId)!;
    expect(target.latest_chunk_ms).not.toBeNull();
    expect(target.latest_chunk_ms!).toBeGreaterThan(0);
  });

  it('does NOT update when cc_session_id is missing', () => {
    seedBrainstorm();
    seedPriorRef();
    db.insertBrainstormChunk({
      id: 'chunk-1',
      brainstorm_id: ANCHOR_ID,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'hi',
      model_id: '',
      cc_session_id: null,
    });
    const refs = db.listLexTranscriptRefs(ANCHOR_ID);
    expect(refs[0]!.latest_chunk_ms).toBeNull();
  });

  it('monotone guard: bump that is not strictly greater is a no-op', () => {
    seedBrainstorm();
    const refId = seedPriorRef();
    /* Direct write to land a value the live insert path cannot beat
     * (Date.now() + 1 day). The monotone guard inside
     * insertBrainstormChunk must reject the smaller live bump. */
    const future = Date.now() + 86_400_000;
    db.bumpLexTranscriptRefLatestChunkMs(CC_PRIOR, future);
    db.insertBrainstormChunk({
      id: 'chunk-2',
      brainstorm_id: ANCHOR_ID,
      turn_index: 1,
      role: 'lex',
      mode: 'conversation',
      text: 'hello',
      model_id: 'test',
      cc_session_id: CC_PRIOR,
    });
    const refs = db.listLexTranscriptRefs(ANCHOR_ID);
    const target = refs.find((r) => r.id === refId)!;
    expect(target.latest_chunk_ms).toBe(future);
  });
});

describe('preloadColdStartSiblings sync barrier', () => {
  it('catches up a stale ref via the per-session generator and clears stale_refs_count after', async () => {
    seedBrainstorm();
    const refId = seedPriorRef();
    /* Stamp the prior ref with summary_ms < latest_chunk_ms so it is
     * stale under the predicate. */
    db.updateLexTranscriptRef(refId, {
      ref_summary: 'old summary',
      ref_summary_ms: 100,
      source_chunk_count: 1,
      source_session_ids: JSON.stringify([CC_PRIOR]),
      coverage_score: 1,
      latest_chunk_ms: 500,
    });
    /* Seed at least one chunk for the prior session so the catchup's
     * countBrainstormChunksForSession returns > 0. */
    db.insertBrainstormChunk({
      id: 'chunk-1',
      brainstorm_id: ANCHOR_ID,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'something the LLM should summarise',
      model_id: '',
      cc_session_id: CC_PRIOR,
    });

    const perSessionGenerator: PerSessionDistillationGenerator = vi.fn(
      async () => ({
        summary: 'refreshed by sync',
        source_chunk_count: 1,
        source_session_ids: JSON.stringify([CC_PRIOR]),
        coverage_score: 1,
      }),
    );

    const summary = await preloadColdStartSiblings({
      db,
      generator: null,
      label: 'codex5',
      excludeId: ANCHOR_ID,
      anchorId: ANCHOR_ID,
      currentCcSessionId: CC_ACTIVE,
      perSessionGenerator,
      syncBudgetMs: 5000,
      now: () => 1_000_000,
    });

    expect(summary.stale_refs_count).toBe(1);
    expect(summary.synced_refs_count).toBe(1);
    expect(summary.partial_sync).toBe(false);
    expect(perSessionGenerator).toHaveBeenCalledTimes(1);
    /* Ref row now carries the refreshed summary + a ref_summary_ms
     * stamped at "now" so the predicate returns false next time. */
    const after = db.listLexTranscriptRefs(ANCHOR_ID).find((r) => r.id === refId)!;
    expect(after.ref_summary).toBe('refreshed by sync');
    expect(after.ref_summary_ms).toBe(1_000_000);
  });

  it('marks partial_sync=true when the per-session generator returns null (timeout/empty)', async () => {
    seedBrainstorm();
    const refId = seedPriorRef();
    db.updateLexTranscriptRef(refId, {
      ref_summary: 'old',
      ref_summary_ms: 100,
      latest_chunk_ms: 500,
    });
    db.insertBrainstormChunk({
      id: 'chunk-1',
      brainstorm_id: ANCHOR_ID,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'x',
      model_id: '',
      cc_session_id: CC_PRIOR,
    });
    const perSessionGenerator: PerSessionDistillationGenerator = vi.fn(
      async () => null,
    );

    const summary = await preloadColdStartSiblings({
      db,
      generator: null,
      label: 'codex5',
      excludeId: ANCHOR_ID,
      anchorId: ANCHOR_ID,
      currentCcSessionId: CC_ACTIVE,
      perSessionGenerator,
      syncBudgetMs: 5000,
      now: () => 1_000_000,
    });

    expect(summary.stale_refs_count).toBe(1);
    expect(summary.synced_refs_count).toBe(0);
    expect(summary.partial_sync).toBe(true);
    /* Ref summary stays unchanged. */
    const after = db.listLexTranscriptRefs(ANCHOR_ID).find((r) => r.id === refId)!;
    expect(after.ref_summary).toBe('old');
  });

  it('no-regression: when every ref is fresh, no sync runs and counters stay zero', async () => {
    seedBrainstorm();
    const refId = seedPriorRef();
    /* Fresh: ref_summary_ms >= latest_chunk_ms. */
    db.updateLexTranscriptRef(refId, {
      ref_summary: 'fresh summary',
      ref_summary_ms: 2000,
      latest_chunk_ms: 2000,
    });
    db.insertBrainstormChunk({
      id: 'chunk-1',
      brainstorm_id: ANCHOR_ID,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'x',
      model_id: '',
      cc_session_id: CC_PRIOR,
    });
    /* Re-stamp latest_chunk_ms == ref_summary_ms to defeat the live
     * Date.now() bump that fires inside insertBrainstormChunk. */
    db.updateLexTranscriptRef(refId, { latest_chunk_ms: 2000 });

    const perSessionGenerator: PerSessionDistillationGenerator = vi.fn(
      async () => ({
        summary: 'should not be called',
        source_chunk_count: 0,
        source_session_ids: '[]',
        coverage_score: 0,
      }),
    );

    const summary = await preloadColdStartSiblings({
      db,
      generator: null,
      label: 'codex5',
      excludeId: ANCHOR_ID,
      anchorId: ANCHOR_ID,
      currentCcSessionId: CC_ACTIVE,
      perSessionGenerator,
      syncBudgetMs: 5000,
      now: () => 1_000_000,
    });

    expect(summary.stale_refs_count).toBe(0);
    expect(summary.synced_refs_count).toBe(0);
    expect(summary.partial_sync).toBe(false);
    expect(perSessionGenerator).not.toHaveBeenCalled();
  });

  it('omits sync when perSessionGenerator is null but still flags stale_refs_count', async () => {
    seedBrainstorm();
    const refId = seedPriorRef();
    db.updateLexTranscriptRef(refId, {
      ref_summary: 'old',
      ref_summary_ms: 100,
      latest_chunk_ms: 500,
    });
    db.insertBrainstormChunk({
      id: 'chunk-1',
      brainstorm_id: ANCHOR_ID,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'x',
      model_id: '',
      cc_session_id: CC_PRIOR,
    });

    const summary = await preloadColdStartSiblings({
      db,
      generator: null,
      label: 'codex5',
      excludeId: ANCHOR_ID,
      anchorId: ANCHOR_ID,
      currentCcSessionId: CC_ACTIVE,
      perSessionGenerator: null,
      syncBudgetMs: 5000,
      now: () => 1_000_000,
    });

    expect(summary.stale_refs_count).toBe(1);
    expect(summary.synced_refs_count).toBe(0);
    /* partial_sync is reserved for "tried but did not catch up"; the
     * no-generator path is "could not try", which stays false. */
    expect(summary.partial_sync).toBe(false);
  });
});
