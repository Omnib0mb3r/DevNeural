/**
 * Codex item 11 (Fix 48) - grooming-watch pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  findFreshestArtifact,
  runGroomingTick,
} from '../src/lex/grooming-watch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
const ANCHOR = 'codex11-anchor';
const CC = '11111111-2222-3333-4444-555555555555';
const NOW = 10_000_000_000;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-codex11-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  db.insertBrainstorm({
    id: ANCHOR,
    claude_session_id: CC,
    pty_id: null,
    cwd: 'C:/dev/codex11',
    user_label: 'codex11',
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: NOW - 5 * 60_000,
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
    cwd: 'C:/dev/codex11',
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

function seedRef(opts: { endedAgo?: number; summary?: string | null }): number {
  const r = db.insertLexTranscriptRef({
    lex_session_id: ANCHOR,
    cc_session_id: CC,
    transcript_path: '/tmp/codex11.jsonl',
    started_ms: NOW - 1_000_000,
    ended_ms: opts.endedAgo !== undefined ? NOW - opts.endedAgo : null,
    ordering: 0,
  });
  if (opts.summary !== undefined) {
    db.updateLexTranscriptRef(r.id, {
      ref_summary: opts.summary,
      ref_summary_ms: opts.summary ? NOW - 1000 : null,
    });
  }
  return r.id;
}

describe('runGroomingTick (Fix 48)', () => {
  it('clear when no detectors trip', () => {
    seedRef({ endedAgo: 1000, summary: 'fresh' });
    const emit = vi.fn();
    const r = runGroomingTick({
      db,
      now: () => NOW,
      emit,
      scanDir: () => [],
      readMtime: () => null,
    });
    expect(r.gaps).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('detects distill_failure_persistent when ref ended >2h ago without summary', () => {
    seedRef({ endedAgo: 3 * 3_600_000, summary: null });
    const r = runGroomingTick({
      db,
      now: () => NOW,
      scanDir: () => [],
      readMtime: () => null,
    });
    expect(
      r.gaps.find((g) => g.class === 'distill_failure_persistent'),
    ).toBeDefined();
  });

  it('detects distill_error_repeat (>=3 same-ref same-class in 24h)', () => {
    seedRef({ endedAgo: 1000, summary: 'x' });
    for (let i = 0; i < 4; i++) {
      db.insertDistillationError({
        id: `e${i}`,
        brainstorm_id: ANCHOR,
        cc_session_id: CC,
        generator: 'per-session',
        error_class: 'provider_threw',
        error_message: null,
      });
    }
    const r = runGroomingTick({
      db,
      /* use real Date.now so the row timestamps fall inside the
       * 24h window (rows were just inserted). */
      scanDir: () => [],
      readMtime: () => null,
    });
    expect(
      r.gaps.find((g) => g.class === 'distill_error_repeat'),
    ).toBeDefined();
  });

  it('detects loose_ends_block_persistent when blocked >1h', () => {
    seedRef({ endedAgo: 1000, summary: 'x' });
    const blocked = new Map<string, number>([[ANCHOR, NOW - 2 * 3_600_000]]);
    const r = runGroomingTick({
      db,
      now: () => NOW,
      scanDir: () => [],
      readMtime: () => null,
      looseEndsBlockedAt: blocked,
    });
    expect(
      r.gaps.find((g) => g.class === 'loose_ends_block_persistent'),
    ).toBeDefined();
  });

  it('detects grooming_gap when artifact mtime ahead of corpus', () => {
    seedRef({ endedAgo: 1000, summary: 'old' });
    /* Corpus high water ~ NOW-1000; freshest artifact 1h ahead. */
    const r = runGroomingTick({
      db,
      now: () => NOW,
      scanDir: (dir) =>
        dir.endsWith('docs/spec') ? ['x.md'] : dir.endsWith('codex11') ? [] : [],
      readMtime: (p) => (p.endsWith('x.md') ? NOW + 60 * 60_000 : null),
    });
    expect(r.gaps.find((g) => g.class === 'grooming_gap')).toBeDefined();
  });

  it('detects idle_no_distill when anchor active >24h with no summary', () => {
    /* Override anchor.started_ms via direct update */
    db.updateBrainstorm(ANCHOR, {
      last_summary: null,
      last_summary_ms: null,
    });
    /* Re-insert ref so corpusHighWater is 0 (no summaries). */
    const r = runGroomingTick({
      db,
      now: () => NOW + 25 * 3_600_000,
      scanDir: () => [],
      readMtime: () => null,
    });
    expect(r.gaps.find((g) => g.class === 'idle_no_distill')).toBeDefined();
  });

  it('debounces second emit for same (anchor, class) within 30 min', () => {
    seedRef({ endedAgo: 3 * 3_600_000, summary: null });
    const emit = vi.fn();
    const state = new Map<string, number>();
    runGroomingTick({
      db,
      now: () => NOW,
      emit,
      state,
      scanDir: () => [],
      readMtime: () => null,
    });
    const before = emit.mock.calls.length;
    runGroomingTick({
      db,
      now: () => NOW + 5 * 60_000,
      emit,
      state,
      scanDir: () => [],
      readMtime: () => null,
    });
    expect(emit.mock.calls.length).toBe(before);
  });

  it('re-emits after debounce window elapses', () => {
    seedRef({ endedAgo: 3 * 3_600_000, summary: null });
    const emit = vi.fn();
    const state = new Map<string, number>();
    runGroomingTick({
      db,
      now: () => NOW,
      emit,
      state,
      scanDir: () => [],
      readMtime: () => null,
    });
    const before = emit.mock.calls.length;
    runGroomingTick({
      db,
      now: () => NOW + 35 * 60_000,
      emit,
      state,
      scanDir: () => [],
      readMtime: () => null,
    });
    expect(emit.mock.calls.length).toBeGreaterThan(before);
  });

  it('severity mapping: warn for distill_failure, alert for loose_ends_block, info for grooming_gap', () => {
    seedRef({ endedAgo: 3 * 3_600_000, summary: null });
    const blocked = new Map<string, number>([[ANCHOR, NOW - 2 * 3_600_000]]);
    const r = runGroomingTick({
      db,
      now: () => NOW,
      scanDir: (dir) =>
        dir.endsWith('docs/bugs') ? ['y.md'] : [],
      readMtime: (p) => (p.endsWith('y.md') ? NOW + 60 * 60_000 : null),
      looseEndsBlockedAt: blocked,
    });
    const f = r.gaps.find((g) => g.class === 'distill_failure_persistent');
    const l = r.gaps.find((g) => g.class === 'loose_ends_block_persistent');
    const gg = r.gaps.find((g) => g.class === 'grooming_gap');
    expect(f?.severity).toBe('warn');
    expect(l?.severity).toBe('alert');
    expect(gg?.severity).toBe('info');
  });
});

describe('findFreshestArtifact (Fix 48)', () => {
  it('returns the file with max mtime across handover/overnight/fixes/spec/bugs', () => {
    const out = findFreshestArtifact('C:/dev/codex11', {
      scanDir: (dir) => {
        if (dir.endsWith('codex11')) return ['HANDOVER-foo.md', 'FIXES.md'];
        if (dir.endsWith('docs/spec')) return ['spec.md'];
        if (dir.endsWith('docs/bugs')) return ['bug.md'];
        return [];
      },
      readMtime: (p) => {
        if (p.endsWith('HANDOVER-foo.md')) return 100;
        if (p.endsWith('FIXES.md')) return 200;
        if (p.endsWith('spec.md')) return 500;
        if (p.endsWith('bug.md')) return 300;
        return null;
      },
    });
    expect(out?.mtime_ms).toBe(500);
    expect(out?.path.endsWith('spec.md')).toBe(true);
  });
});
