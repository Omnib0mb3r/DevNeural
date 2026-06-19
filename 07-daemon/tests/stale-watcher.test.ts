/**
 * LEX-AUTONOMY codex item 6 (Fix 43) - distillation staleness watcher.
 *
 * Pins: (a) fires emit when oldest stale ref age > threshold T; (b)
 * does NOT fire when within threshold; (c) debounces per-anchor over
 * the cooldown window; (d) writes notify_class='signal' with
 * source='staleness-watch'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { runStaleWatchTick } from '../src/lex/stale-watcher.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
const ANCHOR_ID = 'brainstorm-stale-watch';
const CC_PRIOR = '00000000-0000-0000-0000-000000000aaa';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-stale-watch-'));
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

function seedActiveAnchor(): void {
  db.insertBrainstorm({
    id: ANCHOR_ID,
    claude_session_id: CC_PRIOR,
    pty_id: null,
    cwd: 'C:/dev/codex6-test',
    user_label: 'codex6',
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
    id: ANCHOR_ID,
    created_ms: 1,
    title: null,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/codex6-test',
  });
}

function seedStaleRef(latestChunkMs: number, refSummaryMs: number | null): number {
  const ref = db.insertLexTranscriptRef({
    lex_session_id: ANCHOR_ID,
    cc_session_id: CC_PRIOR,
    transcript_path: '/tmp/prior.jsonl',
    started_ms: 100,
    ended_ms: 200,
    ordering: 0,
  });
  const patch: { latest_chunk_ms: number; ref_summary_ms?: number } = {
    latest_chunk_ms: latestChunkMs,
  };
  if (refSummaryMs !== null) patch.ref_summary_ms = refSummaryMs;
  db.updateLexTranscriptRef(ref.id, patch);
  return ref.id;
}

describe('runStaleWatchTick (Fix 43)', () => {
  it('fires emit when oldest stale ref age > threshold', () => {
    seedActiveAnchor();
    const now = 10_000_000;
    seedStaleRef(now - 60 * 60_000, now - 2 * 60 * 60_000); // stale: latest > summary
    const emit = vi.fn(() => ({ id: 'n1' }));
    const r = runStaleWatchTick({
      db,
      emit,
      now: () => now,
      thresholdMs: 10 * 60_000, // 10 min
      debounceMs: 30 * 60_000,
      state: new Map(),
    });
    expect(r.fired).toEqual([ANCHOR_ID]);
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0]![0];
    expect(call.notify_class).toBe('signal');
    expect(call.source).toBe('staleness-watch');
    expect(call.severity).toBe('warn');
    expect(call.push).toBe('suppress');
  });

  it('does NOT fire when stale within the threshold window', () => {
    seedActiveAnchor();
    const now = 10_000_000;
    /* Stale (latest > summary) but only 1 minute since last chunk.
     * Threshold is 10 min so this is informational only. */
    seedStaleRef(now - 60_000, now - 5 * 60_000);
    const emit = vi.fn(() => ({ id: 'n1' }));
    const r = runStaleWatchTick({
      db,
      emit,
      now: () => now,
      thresholdMs: 10 * 60_000,
      state: new Map(),
    });
    expect(r.fired).toEqual([]);
    expect(r.skipped_fresh).toEqual([ANCHOR_ID]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('does NOT fire when all refs are fresh (latest <= summary)', () => {
    seedActiveAnchor();
    const now = 10_000_000;
    /* Fresh: summary written after the latest chunk. */
    seedStaleRef(now - 90 * 60_000, now - 60 * 60_000);
    const emit = vi.fn(() => ({ id: 'n1' }));
    const r = runStaleWatchTick({
      db,
      emit,
      now: () => now,
      thresholdMs: 10 * 60_000,
      state: new Map(),
    });
    expect(r.fired).toEqual([]);
    expect(r.skipped_fresh).toEqual([ANCHOR_ID]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('debounces a second tick inside the cooldown window', () => {
    seedActiveAnchor();
    const now = 10_000_000;
    seedStaleRef(now - 60 * 60_000, now - 2 * 60 * 60_000);
    const emit = vi.fn(() => ({ id: 'n1' }));
    const state = new Map<string, number>();
    const r1 = runStaleWatchTick({
      db,
      emit,
      now: () => now,
      thresholdMs: 10 * 60_000,
      debounceMs: 30 * 60_000,
      state,
    });
    expect(r1.fired).toEqual([ANCHOR_ID]);
    /* Second tick 5 min later: still inside the 30-min debounce. */
    const r2 = runStaleWatchTick({
      db,
      emit,
      now: () => now + 5 * 60_000,
      thresholdMs: 10 * 60_000,
      debounceMs: 30 * 60_000,
      state,
    });
    expect(r2.fired).toEqual([]);
    expect(r2.skipped_debounced).toEqual([ANCHOR_ID]);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('sliver 2c: onStale fires with threshold-crossed anchors', () => {
    seedActiveAnchor();
    const now = 10_000_000;
    seedStaleRef(now - 60 * 60_000, now - 2 * 60 * 60_000);
    const onStale = vi.fn();
    const r = runStaleWatchTick({
      db,
      emit: vi.fn(() => ({ id: 'n1' })),
      onStale,
      now: () => now,
      thresholdMs: 10 * 60_000,
      debounceMs: 30 * 60_000,
      state: new Map(),
    });
    expect(r.stale_past_threshold).toEqual([ANCHOR_ID]);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledWith([ANCHOR_ID]);
  });

  it('sliver 2c: onStale does NOT fire when stale within the threshold', () => {
    seedActiveAnchor();
    const now = 10_000_000;
    seedStaleRef(now - 60_000, now - 5 * 60_000); // 1 min old, < 10 min threshold
    const onStale = vi.fn();
    const r = runStaleWatchTick({
      db,
      emit: vi.fn(() => ({ id: 'n1' })),
      onStale,
      now: () => now,
      thresholdMs: 10 * 60_000,
      state: new Map(),
    });
    expect(r.stale_past_threshold).toEqual([]);
    expect(onStale).not.toHaveBeenCalled();
  });

  it('sliver 2c: onStale fires even when the bell is debounced', () => {
    seedActiveAnchor();
    const now = 10_000_000;
    seedStaleRef(now - 60 * 60_000, now - 2 * 60 * 60_000);
    const onStale = vi.fn();
    const emit = vi.fn(() => ({ id: 'n1' }));
    /* Pre-seed the debounce so the bell is suppressed this tick. */
    const state = new Map<string, number>([[ANCHOR_ID, now - 60_000]]);
    const r = runStaleWatchTick({
      db,
      emit,
      onStale,
      now: () => now,
      thresholdMs: 10 * 60_000,
      debounceMs: 30 * 60_000,
      state,
    });
    expect(r.fired).toEqual([]); // bell debounced
    expect(r.skipped_debounced).toEqual([ANCHOR_ID]);
    expect(emit).not.toHaveBeenCalled();
    /* ...but the action trigger still fires: staleness must be acted on
     * regardless of how recently the bell rang. */
    expect(onStale).toHaveBeenCalledWith([ANCHOR_ID]);
  });

  it('sliver 2c: a throwing onStale never breaks the tick', () => {
    seedActiveAnchor();
    const now = 10_000_000;
    seedStaleRef(now - 60 * 60_000, now - 2 * 60 * 60_000);
    const emit = vi.fn(() => ({ id: 'n1' }));
    const r = runStaleWatchTick({
      db,
      emit,
      onStale: () => {
        throw new Error('scheduler exploded');
      },
      now: () => now,
      thresholdMs: 10 * 60_000,
      debounceMs: 30 * 60_000,
      state: new Map(),
    });
    /* The bell still fired and the tick returned a normal result. */
    expect(r.fired).toEqual([ANCHOR_ID]);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('re-fires after the debounce window elapses', () => {
    seedActiveAnchor();
    const now = 10_000_000;
    seedStaleRef(now - 60 * 60_000, now - 2 * 60 * 60_000);
    const emit = vi.fn(() => ({ id: 'n1' }));
    const state = new Map<string, number>();
    runStaleWatchTick({
      db,
      emit,
      now: () => now,
      thresholdMs: 10 * 60_000,
      debounceMs: 30 * 60_000,
      state,
    });
    /* 31 min later -> outside the debounce. */
    const r2 = runStaleWatchTick({
      db,
      emit,
      now: () => now + 31 * 60_000,
      thresholdMs: 10 * 60_000,
      debounceMs: 30 * 60_000,
      state,
    });
    expect(r2.fired).toEqual([ANCHOR_ID]);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
