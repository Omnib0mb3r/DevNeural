/**
 * Crash recovery (sliver 4).
 *
 * detectCrashGap: a gap = activity (latest_chunk_ms) past the last clean
 * checkpoint (newest cold-start report ms / last_summary_ms). A clean
 * shutdown or a fresh report closes it.
 *
 * recoverCrashedAnchors: scans candidates, recovers only crashed ones,
 * respects the cap, survives a detector/recover throw. Orchestration is
 * driven with injected seams so no real session-end flush runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { writeColdStartReport } from '../src/lex/cold-start-report.js';
import {
  detectCrashGap,
  recoverCrashedAnchors,
  type CrashGap,
} from '../src/lex/crash-recovery.js';
import type { Store } from '../src/store/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let prior: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-crash-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  prior = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  if (prior === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = prior;
  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedAnchor(id: string): void {
  db.insertBrainstorm({
    id,
    claude_session_id: `cc-${id}`,
    pty_id: null,
    cwd: 'C:/dev/crash-test',
    user_label: 'crash',
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
    id,
    created_ms: 1,
    title: null,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/crash-test',
  });
}

function seedRef(
  anchorId: string,
  latestChunkMs: number,
  refSummaryMs: number | null,
): void {
  const ref = db.insertLexTranscriptRef({
    lex_session_id: anchorId,
    cc_session_id: `cc-${anchorId}`,
    transcript_path: `/tmp/${anchorId}.jsonl`,
    started_ms: 100,
    ended_ms: 200,
    ordering: 0,
  });
  const patch: { latest_chunk_ms: number; ref_summary_ms?: number } = {
    latest_chunk_ms: latestChunkMs,
  };
  if (refSummaryMs !== null) patch.ref_summary_ms = refSummaryMs;
  db.updateLexTranscriptRef(ref.id, patch);
}

describe('detectCrashGap', () => {
  it('flags a crash gap when activity landed past the last clean checkpoint', () => {
    seedAnchor('bs-crash');
    seedRef('bs-crash', 10_000, null); // chunk at 10000, never distilled
    const gap = detectCrashGap(db, 'bs-crash');
    expect(gap.crashed).toBe(true);
    expect(gap.latestActivityMs).toBe(10_000);
    expect(gap.lastCleanMs).toBe(0);
  });

  it('is clean when last_summary_ms is past the latest chunk (clean shutdown)', () => {
    seedAnchor('bs-clean');
    seedRef('bs-clean', 10_000, 11_000);
    db.updateBrainstorm('bs-clean', { last_summary_ms: 11_000 });
    const gap = detectCrashGap(db, 'bs-clean');
    expect(gap.crashed).toBe(false);
    expect(gap.lastCleanMs).toBe(11_000);
  });

  it('is clean when a cold-start report postdates the latest chunk', () => {
    seedAnchor('bs-report');
    /* Epoch-ms scale: the report filename is the ms (>=10 digits). */
    seedRef('bs-report', 1_700_000_000_000, null);
    /* Report written after the latest chunk = a clean checkpoint. */
    writeColdStartReport('bs-report', 'seed', 1_700_000_012_000);
    const gap = detectCrashGap(db, 'bs-report');
    expect(gap.crashed).toBe(false);
    expect(gap.lastCleanMs).toBe(1_700_000_012_000);
  });

  it('is clean when there is no activity (no refs)', () => {
    seedAnchor('bs-empty');
    const gap = detectCrashGap(db, 'bs-empty');
    expect(gap.crashed).toBe(false);
    expect(gap.latestActivityMs).toBe(0);
  });
});

function gapStub(id: string, crashed: boolean): CrashGap {
  return {
    anchorId: id,
    crashed,
    lastCleanMs: 0,
    latestActivityMs: crashed ? 10_000 : 0,
    staleRefCount: crashed ? 1 : 0,
  };
}

const fakeStore = { db: {} } as unknown as Store;

describe('recoverCrashedAnchors', () => {
  it('recovers only the crashed anchors', async () => {
    const recovered: string[] = [];
    const r = await recoverCrashedAnchors({
      store: fakeStore,
      listAnchors: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      detect: (id) => gapStub(id, id !== 'b'),
      recover: async (gap) => {
        recovered.push(gap.anchorId);
      },
    });
    expect(r.scanned).toBe(3);
    expect(r.recovered).toEqual(['a', 'c']);
    expect(recovered).toEqual(['a', 'c']);
  });

  it('respects the cap and reports skipped_cap', async () => {
    const r = await recoverCrashedAnchors({
      store: fakeStore,
      limit: 2,
      listAnchors: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      detect: (id) => gapStub(id, true),
      recover: async () => undefined,
    });
    expect(r.recovered).toHaveLength(2);
    expect(r.skipped_cap).toBe(1);
  });

  it('limit=0 disables the sweep', async () => {
    const recover = vi.fn(async () => undefined);
    const r = await recoverCrashedAnchors({
      store: fakeStore,
      limit: 0,
      listAnchors: () => [{ id: 'a' }],
      detect: (id) => gapStub(id, true),
      recover,
    });
    expect(r.scanned).toBe(0);
    expect(recover).not.toHaveBeenCalled();
  });

  it('a recover throw does not abort the sweep', async () => {
    const r = await recoverCrashedAnchors({
      store: fakeStore,
      listAnchors: () => [{ id: 'a' }, { id: 'b' }],
      detect: (id) => gapStub(id, true),
      recover: async (gap) => {
        if (gap.anchorId === 'a') throw new Error('flush blew up');
      },
    });
    /* a threw, b still recovered; sweep completed. */
    expect(r.recovered).toEqual(['b']);
    expect(r.scanned).toBe(2);
  });
});
