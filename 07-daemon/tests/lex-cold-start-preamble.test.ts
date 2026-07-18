/**
 * Cold-start preamble + force-distill race resolver.
 *
 * Pins:
 *   - preloadColdStartSiblings synchronously force-distills the
 *     top-N siblings when their last_summary is null (cron has not
 *     yet fired). The summary it returns carries the metadata the
 *     visibility layers consume (sibling_count, last_distilled_ms,
 *     recent_turns_appended, failure_reason).
 *   - When the cron HAS fired (last_summary already present), the
 *     race resolver no-ops: generator is not called again and the
 *     existing distillation is used as-is.
 *   - formatColdStartPreamble produces the one-liner Lex prints
 *     verbatim on the first reply for every covered branch.
 *   - formatHeaderStatus renders the brainstorm UI pill copy in
 *     both ok and err tones.
 *   - recordPreloadEvent + groupPreloadEventsBySession give the
 *     dashboard panel a per-brainstorm view so two concurrently
 *     running sessions never get mashed into one feed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  _resetPreloadEventLog,
  buildPreloadEventLogRow,
  formatColdStartPreamble,
  formatHeaderStatus,
  groupPreloadEventsBySession,
  listPreloadEvents,
  preloadColdStartSiblings,
  recordPreloadEvent,
} from '../src/lex/lex-cold-start-preamble.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

function seedBs(opts: {
  id: string;
  label: string | null;
  started_ms: number;
  last_summary?: string | null;
  last_summary_ms?: number | null;
  chunk_count?: number;
}): void {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/p/lex',
    user_label: opts.label,
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: opts.started_ms,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: opts.last_summary ?? null,
    last_summary_ms: opts.last_summary_ms ?? null,
  });
  const n = opts.chunk_count ?? 0;
  for (let i = 0; i < n; i++) {
    db.insertBrainstormChunk({
      id: `c-${opts.id}-${i}`,
      brainstorm_id: opts.id,
      turn_index: i,
      role: 'user',
      mode: 'conversation',
      text: `chunk ${i}`,
      model_id: 'stub',
      no_decay: 1,
    });
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-coldpreamble-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  _resetPreloadEventLog();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('preloadColdStartSiblings', () => {
  it('force-distills the just-ended sibling synchronously when the cron has not yet fired', async () => {
    /* Just-ended sibling: chunks present, last_summary still null
     * (cron has not caught up). The race resolver must invoke the
     * generator BEFORE assembling the surfaced-sibling list. */
    seedBs({ id: 'just-ended', label: 'Topic', started_ms: 2_000, chunk_count: 4 });
    /* Older sibling with chunks but no summary either. */
    seedBs({ id: 'older', label: 'Topic', started_ms: 1_000, chunk_count: 2 });
    const generator = vi.fn().mockResolvedValue('one line summary text');
    const r = await preloadColdStartSiblings({
      db,
      generator,
      label: 'Topic',
      excludeId: 'spawn-new',
      forceForTopN: 2,
      now: () => 9_999,
    });
    expect(generator).toHaveBeenCalledTimes(2);
    expect(r.failure_reason).toBeNull();
    expect(r.sibling_count).toBe(2);
    expect(r.last_distilled_ms).toBe(9_999);
    expect(r.recent_turns_appended).toBe(6);
    expect(r.preload.preloaded.sort()).toEqual(['just-ended', 'older']);
  });

  it('no-ops when the cron has already distilled the surfaced siblings (existing summary wins)', async () => {
    seedBs({
      id: 'just-ended',
      label: 'Topic',
      started_ms: 2_000,
      last_summary: 'cron-produced summary',
      last_summary_ms: 5_555,
      chunk_count: 3,
    });
    seedBs({
      id: 'older',
      label: 'Topic',
      started_ms: 1_000,
      last_summary: 'older summary',
      last_summary_ms: 4_444,
      chunk_count: 1,
    });
    const generator = vi.fn().mockResolvedValue('SHOULD NOT BE USED');
    const r = await preloadColdStartSiblings({
      db,
      generator,
      label: 'Topic',
      excludeId: 'spawn-new',
      forceForTopN: 2,
    });
    expect(generator).not.toHaveBeenCalled();
    expect(r.failure_reason).toBeNull();
    expect(r.sibling_count).toBe(2);
    expect(r.last_distilled_ms).toBe(5_555);
    expect(r.recent_turns_appended).toBe(4);
    expect(r.preload.already_present.sort()).toEqual(['just-ended', 'older']);
  });

  it('returns failure_reason=no-label when the new session has no user_label', async () => {
    const r = await preloadColdStartSiblings({
      db,
      generator: vi.fn().mockResolvedValue('x'),
      label: null,
      excludeId: 'spawn-new',
    });
    expect(r.failure_reason).toBe('no-label');
    expect(r.sibling_count).toBe(0);
  });

  it('returns failure_reason=no-siblings when no other brainstorm shares the label', async () => {
    seedBs({ id: 'lonely', label: 'OtherTopic', started_ms: 1, chunk_count: 1 });
    const r = await preloadColdStartSiblings({
      db,
      generator: vi.fn().mockResolvedValue('x'),
      label: 'Topic',
      excludeId: 'spawn-new',
    });
    expect(r.failure_reason).toBe('no-siblings');
    expect(r.sibling_count).toBe(0);
  });

  it('captures a thrown preloader error in failure_reason instead of throwing', async () => {
    seedBs({ id: 'a', label: 'Topic', started_ms: 1, chunk_count: 1 });
    const generator = vi.fn().mockRejectedValue(new Error('llm down'));
    /* The generator throw is swallowed inside the preloader itself
     * (it buckets the row as skipped); the outer surface only flips
     * to failure_reason when the preloader's contract throws,
     * which doesn't happen for a single failing row. Confirm we
     * get a clean summary with the failing row in skipped[]. */
    const r = await preloadColdStartSiblings({
      db,
      generator,
      label: 'Topic',
      excludeId: 'spawn-new',
      forceForTopN: 2,
    });
    expect(r.failure_reason).toBeNull();
    expect(r.preload.skipped).toContain('a');
  });
});

describe('formatColdStartPreamble', () => {
  it('formats the canonical multi-sibling line with a fixed timezone tag', () => {
    const out = formatColdStartPreamble(
      {
        preload: { preloaded: [], skipped: [], already_present: [] },
        sibling_count: 4,
        last_distilled_ms: new Date(2026, 4, 14, 14, 32, 0).valueOf(),
        recent_turns_appended: 12,
        failure_reason: null,
      },
      /* SM-26: inject now 30min after the stamp so the FRESH branch
       * renders (past 6h the line carries an explicit age). */
      { timeZoneTag: 'EDT', now: () => new Date(2026, 4, 14, 15, 2, 0) },
    );
    expect(out).toContain(
      'Loaded 4 sibling sessions, last distilled 14:32 EDT, 12 recent turns appended.',
    );
    expect(out).toContain('context_verdict=');
  });

  it('SM-26: past 6h the distilled line carries explicit age + trust hint', () => {
    const out = formatColdStartPreamble(
      {
        preload: { preloaded: [], skipped: [], already_present: [] },
        sibling_count: 2,
        last_distilled_ms: new Date(2026, 4, 13, 21, 4, 0).valueOf(),
        recent_turns_appended: 5,
        failure_reason: null,
      },
      { timeZoneTag: 'EDT', now: () => new Date(2026, 4, 14, 17, 4, 0) },
    );
    expect(out).toContain('last distilled 20h ago (21:04 EDT');
    expect(out).toContain('trust the appended recent turns');
  });

  it('singularises the sibling + turn words for count=1', () => {
    const out = formatColdStartPreamble(
      {
        preload: { preloaded: [], skipped: [], already_present: [] },
        sibling_count: 1,
        last_distilled_ms: new Date(2026, 4, 14, 9, 5, 0).valueOf(),

        recent_turns_appended: 1,
        failure_reason: null,
      },
      { timeZoneTag: 'EDT', now: () => new Date(2026, 4, 14, 9, 35, 0) },
    );
    expect(out).toContain(
      'Loaded 1 sibling session, last distilled 09:05 EDT, 1 recent turn appended.',
    );
    expect(out).toContain('context_verdict=');
  });

  it('falls back to "distillation not yet available" when no sibling has been distilled', () => {
    const out = formatColdStartPreamble(
      {
        preload: { preloaded: [], skipped: [], already_present: [] },
        sibling_count: 2,
        last_distilled_ms: null,
        recent_turns_appended: 3,
        failure_reason: null,
      },
      { timeZoneTag: 'EDT' },
    );
    expect(out).toContain('distillation not yet available');
  });

  it('emits a cold-start message when there are no siblings', () => {
    const out = formatColdStartPreamble(
      {
        preload: { preloaded: [], skipped: [], already_present: [] },
        sibling_count: 0,
        last_distilled_ms: null,
        recent_turns_appended: 0,
        failure_reason: 'no-siblings',
      },
      { timeZoneTag: 'EDT' },
    );
    expect(out).toContain('Cold start: no prior sibling sessions found.');
    expect(out).toContain('context_verdict=empty');
  });

  it('appends the verdict + last_child + distillation_gap on a stale summary', () => {
    const out = formatColdStartPreamble(
      {
        preload: { preloaded: [], skipped: [], already_present: [] },
        sibling_count: 3,
        last_distilled_ms: 1_000,
        recent_turns_appended: 8,
        failure_reason: null,
        stale_refs_count: 1,
        synced_refs_count: 0,
        partial_sync: false,
        context_verdict: 'stale',
        last_child_session_id: 'cc-aaaa',
        last_child_session_title: 'DevNeural Testing',
        last_child_session_ended_ms: 7_300_000,
        distillation_gap_ms: 7_299_000,
      },
      { timeZoneTag: 'EDT' },
    );
    expect(out).toContain('context_verdict=stale');
    expect(out).toContain('last_child=DevNeural Testing');
    expect(out).toContain('distillation_gap_ms=7299000');
  });
});

describe('context_verdict resolver', () => {
  it('promotes partial when partial_sync=true regardless of gap', async () => {
    /* Direct call to formatColdStartPreamble surfaces the wired
     * verdict in the line. Verdict resolution itself lives in
     * preloadColdStartSiblings via finalizeContextVerdict; this pin
     * locks the contract that partial_sync overrides every other
     * threshold so the operator never sees fresh while refs are
     * still in flight. */
    const out = formatColdStartPreamble(
      {
        preload: { preloaded: [], skipped: [], already_present: [] },
        sibling_count: 2,
        last_distilled_ms: 9_000_000,
        recent_turns_appended: 3,
        failure_reason: null,
        stale_refs_count: 0,
        synced_refs_count: 0,
        partial_sync: true,
        context_verdict: 'partial',
        last_child_session_id: 'cc',
        last_child_session_title: 'Active anchor',
        last_child_session_ended_ms: 9_000_001,
        distillation_gap_ms: 1,
      },
      { timeZoneTag: 'EDT' },
    );
    expect(out).toContain('context_verdict=partial');
  });

  it('renders verdict=outdated label distinctly', () => {
    const out = formatColdStartPreamble(
      {
        preload: { preloaded: [], skipped: [], already_present: [] },
        sibling_count: 1,
        last_distilled_ms: 1_000,
        recent_turns_appended: 0,
        failure_reason: null,
        stale_refs_count: 0,
        synced_refs_count: 0,
        partial_sync: false,
        context_verdict: 'outdated',
        last_child_session_id: 'cc-old',
        last_child_session_title: 'Stale anchor',
        last_child_session_ended_ms: 10 * 24 * 60 * 60 * 1000,
        distillation_gap_ms: 10 * 24 * 60 * 60 * 1000 - 1_000,
      },
      { timeZoneTag: 'EDT' },
    );
    expect(out).toContain('context_verdict=outdated');
    expect(out).toContain('last_child=Stale anchor');
  });
});

describe('formatHeaderStatus', () => {
  it('renders ok tone on success', () => {
    const out = formatHeaderStatus({
      preload: { preloaded: [], skipped: [], already_present: [] },
      sibling_count: 3,
      last_distilled_ms: 1,
      recent_turns_appended: 9,
      failure_reason: null,
    });
    expect(out).toEqual({
      tone: 'ok',
      text: 'context: 3 siblings + 9 turns',
    });
  });

  it('renders err tone with the failure reason', () => {
    const out = formatHeaderStatus({
      preload: { preloaded: [], skipped: [], already_present: [] },
      sibling_count: 0,
      last_distilled_ms: null,
      recent_turns_appended: 0,
      failure_reason: 'no-label',
    });
    expect(out).toEqual({
      tone: 'err',
      text: 'context: failed (no-label)',
    });
  });
});

describe('preload event log (multi-session grouping)', () => {
  it('listPreloadEvents returns most-recent first, optionally filtered by brainstorm_id', () => {
    recordPreloadEvent(
      buildPreloadEventLogRow({
        brainstormId: 'bs-a',
        ccSessionId: 'cc-a-1',
        summary: {
          preload: { preloaded: ['s1'], skipped: [], already_present: [] },
          sibling_count: 1,
          last_distilled_ms: 1,
          recent_turns_appended: 1,
          failure_reason: null,
        },
        preamble: 'a-old',
        ts: '2026-05-14T09:00:00Z',
      }),
    );
    recordPreloadEvent(
      buildPreloadEventLogRow({
        brainstormId: 'bs-b',
        ccSessionId: 'cc-b-1',
        summary: {
          preload: { preloaded: [], skipped: [], already_present: ['s2'] },
          sibling_count: 1,
          last_distilled_ms: 2,
          recent_turns_appended: 2,
          failure_reason: null,
        },
        preamble: 'b-old',
        ts: '2026-05-14T09:30:00Z',
      }),
    );
    recordPreloadEvent(
      buildPreloadEventLogRow({
        brainstormId: 'bs-a',
        ccSessionId: 'cc-a-2',
        summary: {
          preload: { preloaded: ['s3'], skipped: [], already_present: [] },
          sibling_count: 2,
          last_distilled_ms: 3,
          recent_turns_appended: 4,
          failure_reason: null,
        },
        preamble: 'a-new',
        ts: '2026-05-14T10:00:00Z',
      }),
    );

    const all = listPreloadEvents({ limit: 10 });
    expect(all.map((r) => r.preamble)).toEqual(['a-new', 'b-old', 'a-old']);

    const onlyA = listPreloadEvents({ brainstormId: 'bs-a' });
    expect(onlyA.map((r) => r.preamble)).toEqual(['a-new', 'a-old']);
  });

  it('groupPreloadEventsBySession returns one group per brainstorm_id with the latest cc_session_id', () => {
    recordPreloadEvent(
      buildPreloadEventLogRow({
        brainstormId: 'bs-a',
        ccSessionId: 'cc-a-1',
        summary: {
          preload: { preloaded: [], skipped: [], already_present: [] },
          sibling_count: 0,
          last_distilled_ms: null,
          recent_turns_appended: 0,
          failure_reason: 'no-siblings',
        },
        preamble: 'a-old',
        ts: '2026-05-14T09:00:00Z',
      }),
    );
    recordPreloadEvent(
      buildPreloadEventLogRow({
        brainstormId: 'bs-b',
        ccSessionId: 'cc-b-1',
        summary: {
          preload: { preloaded: ['s2'], skipped: [], already_present: [] },
          sibling_count: 1,
          last_distilled_ms: 2,
          recent_turns_appended: 5,
          failure_reason: null,
        },
        preamble: 'b-only',
        ts: '2026-05-14T09:15:00Z',
      }),
    );
    recordPreloadEvent(
      buildPreloadEventLogRow({
        brainstormId: 'bs-a',
        ccSessionId: 'cc-a-2',
        summary: {
          preload: { preloaded: ['s3'], skipped: [], already_present: [] },
          sibling_count: 1,
          last_distilled_ms: 3,
          recent_turns_appended: 7,
          failure_reason: null,
        },
        preamble: 'a-new',
        ts: '2026-05-14T09:45:00Z',
      }),
    );

    const groups = groupPreloadEventsBySession({});
    /* Most-recent walk means bs-a (latest event @ 09:45) lands first.
     * cc_session_id is the latest binding (cc-a-2). */
    expect(groups.map((g) => g.brainstorm_id)).toEqual(['bs-a', 'bs-b']);
    const a = groups.find((g) => g.brainstorm_id === 'bs-a')!;
    expect(a.cc_session_id).toBe('cc-a-2');
    expect(a.rows.map((r) => r.preamble)).toEqual(['a-new', 'a-old']);
    const b = groups.find((g) => g.brainstorm_id === 'bs-b')!;
    expect(b.cc_session_id).toBe('cc-b-1');
    expect(b.rows.map((r) => r.preamble)).toEqual(['b-only']);
  });
});
