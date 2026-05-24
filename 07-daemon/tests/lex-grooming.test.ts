/**
 * Grooming pass + idle-watcher decision logic (Phase 2 of LSS).
 *
 * Focused on the pure pieces: decidePendingPass for threshold +
 * idempotency, runGroomingPass for the per-kind side effects via
 * injected db / generator / writeHandover / runFinalDistillation
 * stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  decidePendingPass,
  runGroomingPass,
  GROOMING_THRESHOLDS_MS,
} from '../src/lex/grooming.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let priorRoot: string | undefined;

const NOW = 1_700_000_000_000;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-grooming-'));
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'EmptyProjectsRoot'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'EmptyProjectsRoot');
  process.env.HOME = path.join(tmpDir, 'home');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  const dbFile = path.join(tmpDir, 'index.db');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* tolerate windows file-lock races on cleanup */
  }
});

function insertBrainstorm(opts: {
  id: string;
  startedMs: number;
  lifecycle?: 'idle' | 'attached' | 'speaking' | 'ended';
  lastUtteranceIso?: string | null;
  lastGroomingIso?: string | null;
  lastGroomingKind?: 'light' | 'mid' | 'cold' | 'day-cap' | null;
}) {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: `/synthetic/${opts.id}`,
    user_label: 'DevNeural Testing',
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: opts.startedMs,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
  db.updateBrainstorm(opts.id, {
    lifecycle_state: opts.lifecycle ?? 'idle',
    last_user_utterance_at: opts.lastUtteranceIso ?? null,
    last_grooming_pass_at: opts.lastGroomingIso ?? null,
    last_grooming_kind: opts.lastGroomingKind ?? null,
  });
}

describe('decidePendingPass', () => {
  it('returns null for a speaking row regardless of silence', () => {
    insertBrainstorm({
      id: 'bs-speak',
      startedMs: NOW - 24 * 60 * 60 * 1000,
      lifecycle: 'speaking',
    });
    const row = db.getBrainstorm('bs-speak')!;
    expect(decidePendingPass(row, NOW).kind).toBeNull();
  });

  it('returns null for an ended row regardless of silence', () => {
    insertBrainstorm({
      id: 'bs-ended',
      startedMs: NOW - 24 * 60 * 60 * 1000,
      lifecycle: 'ended',
    });
    const row = db.getBrainstorm('bs-ended')!;
    expect(decidePendingPass(row, NOW).kind).toBeNull();
  });

  it('returns null when silence is below the light threshold', () => {
    insertBrainstorm({
      id: 'bs-fresh',
      startedMs: NOW - 60_000,
      lastUtteranceIso: new Date(NOW - 60_000).toISOString(),
    });
    const row = db.getBrainstorm('bs-fresh')!;
    const out = decidePendingPass(row, NOW);
    expect(out.kind).toBeNull();
    expect(out.silenceMs).toBeLessThan(GROOMING_THRESHOLDS_MS.light);
  });

  it.each([
    ['light' as const, GROOMING_THRESHOLDS_MS.light + 1000],
    ['mid' as const, GROOMING_THRESHOLDS_MS.mid + 1000],
    ['cold' as const, GROOMING_THRESHOLDS_MS.cold + 1000],
    ['day-cap' as const, GROOMING_THRESHOLDS_MS['day-cap'] + 1000],
  ])('escalates to %s after silence >= the kind threshold', (kind, silenceMs) => {
    const id = `bs-${kind}-escalate`;
    insertBrainstorm({
      id,
      startedMs: NOW - silenceMs,
      lastUtteranceIso: new Date(NOW - silenceMs).toISOString(),
    });
    const row = db.getBrainstorm(id)!;
    expect(decidePendingPass(row, NOW).kind).toBe(kind);
  });

  it('falls back to started_ms when last_user_utterance_at is null', () => {
    insertBrainstorm({
      id: 'bs-no-utterance',
      startedMs: NOW - GROOMING_THRESHOLDS_MS.cold - 5000,
    });
    const row = db.getBrainstorm('bs-no-utterance')!;
    expect(decidePendingPass(row, NOW).kind).toBe('cold');
  });

  it('does NOT re-fire the same kind when a pass already ran after the baseline', () => {
    /* User talked 90 min ago (well past the cold threshold). A cold
     * pass ran 70 min ago. No new utterance since, so the baseline
     * has not moved and the cooldown holds. */
    const utteranceMs = NOW - 90 * 60 * 1000;
    const passMs = NOW - 70 * 60 * 1000;
    insertBrainstorm({
      id: 'bs-cooldown',
      startedMs: utteranceMs - 1000,
      lastUtteranceIso: new Date(utteranceMs).toISOString(),
      lastGroomingIso: new Date(passMs).toISOString(),
      lastGroomingKind: 'cold',
    });
    const row = db.getBrainstorm('bs-cooldown')!;
    expect(decidePendingPass(row, NOW).kind).toBeNull();
  });

  it('escalates from a prior light pass to a fresh mid pass once silence reaches mid', () => {
    /* light ran shortly after the user's last utterance; now silence
     * has crossed the mid threshold so a mid pass is due even
     * though a light pass already happened post-baseline. */
    const utteranceMs = NOW - GROOMING_THRESHOLDS_MS.mid - 5000;
    const lightRanMs = utteranceMs + GROOMING_THRESHOLDS_MS.light + 1000;
    insertBrainstorm({
      id: 'bs-escalation',
      startedMs: utteranceMs - 1000,
      lastUtteranceIso: new Date(utteranceMs).toISOString(),
      lastGroomingIso: new Date(lightRanMs).toISOString(),
      lastGroomingKind: 'light',
    });
    const row = db.getBrainstorm('bs-escalation')!;
    expect(decidePendingPass(row, NOW).kind).toBe('mid');
  });

  it('re-arms every threshold after a new user utterance resets the baseline', () => {
    /* Previously did a cold pass; then the user spoke; now silent
     * past the light threshold again. */
    const earlierUtteranceMs = NOW - 4 * 60 * 60 * 1000;
    const earlierCold = earlierUtteranceMs + GROOMING_THRESHOLDS_MS.cold + 1000;
    const freshUtteranceMs = NOW - GROOMING_THRESHOLDS_MS.light - 1000;
    insertBrainstorm({
      id: 'bs-rearm',
      startedMs: earlierUtteranceMs - 1000,
      lastUtteranceIso: new Date(freshUtteranceMs).toISOString(),
      lastGroomingIso: new Date(earlierCold).toISOString(),
      lastGroomingKind: 'cold',
    });
    const row = db.getBrainstorm('bs-rearm')!;
    expect(decidePendingPass(row, NOW).kind).toBe('light');
  });
});

describe('runGroomingPass', () => {
  function insertWithChunks(id: string, numChunks: number, lifecycle: 'idle' | 'attached' = 'idle') {
    insertBrainstorm({
      id,
      startedMs: NOW - 60_000,
      lifecycle,
      lastUtteranceIso: new Date(NOW - 70 * 60 * 1000).toISOString(),
    });
    for (let i = 0; i < numChunks; i++) {
      db.insertBrainstormChunk({
        id: `${id}-c${i}`,
        brainstorm_id: id,
        turn_index: i,
        role: i % 2 === 0 ? 'user' : 'lex',
        mode: 'conversation',
        text: `turn ${i}`,
        model_id: i % 2 === 0 ? '' : 'claude',
        no_decay: 1,
        created_at: new Date(NOW - 60_000 + i * 1000).toISOString(),
      });
    }
  }

  it('cold pass writes a HANDOVER doc and stamps last_grooming_kind=cold', async () => {
    insertWithChunks('bs-cold-run', 4);
    const generator = vi.fn(async () => 'stub rolling summary');
    const writeHandover = vi.fn(() => ({
      filePath: '/synthetic/HANDOVER-x.md',
      bytes: 100,
    }));
    const result = await runGroomingPass('cold', 'bs-cold-run', {
      db,
      generator,
      writeHandover,
      now: () => NOW,
    });
    expect(result.kind).toBe('cold');
    expect(result.handover_written).toBe(true);
    expect(result.handover_path).toBe('/synthetic/HANDOVER-x.md');
    expect(generator).toHaveBeenCalledTimes(1);
    expect(writeHandover).toHaveBeenCalledTimes(1);
    const refreshed = db.getBrainstorm('bs-cold-run')!;
    expect(refreshed.last_grooming_kind).toBe('cold');
    expect(refreshed.last_grooming_pass_at).toBeTruthy();
    expect(refreshed.last_summary).toBe('stub rolling summary');
  });

  it('light pass skips the rolling summary when new-turn count is below the floor', async () => {
    insertWithChunks('bs-light-skip', 2);
    const generator = vi.fn(async () => 'should not be called');
    const result = await runGroomingPass('light', 'bs-light-skip', {
      db,
      generator,
      now: () => NOW,
    });
    expect(result.rolling_summary_written).toBe(false);
    expect(generator).not.toHaveBeenCalled();
    expect(result.handover_written).toBeNull();
  });

  it('day-cap pass flips lifecycle_state to ended and invokes the final distillation hook', async () => {
    insertWithChunks('bs-day-cap', 12);
    const writeHandover = vi.fn(() => ({
      filePath: '/synthetic/HANDOVER-y.md',
      bytes: 50,
    }));
    const runFinalDistillation = vi.fn(async () => undefined);
    const result = await runGroomingPass('day-cap', 'bs-day-cap', {
      db,
      generator: vi.fn(async () => 'summary'),
      writeHandover,
      runFinalDistillation,
      now: () => NOW,
    });
    expect(result.ended_at_day_cap).toBe(true);
    expect(runFinalDistillation).toHaveBeenCalledWith('bs-day-cap');
    const refreshed = db.getBrainstorm('bs-day-cap')!;
    expect(refreshed.lifecycle_state).toBe('ended');
    expect(refreshed.status).toBe('ended');
    expect(refreshed.last_grooming_kind).toBe('day-cap');
  });

  it('skips a row whose lifecycle flipped to speaking between watcher tick and runGroomingPass', async () => {
    insertWithChunks('bs-mid-flip', 12);
    db.updateBrainstorm('bs-mid-flip', { lifecycle_state: 'speaking' });
    const result = await runGroomingPass('cold', 'bs-mid-flip', {
      db,
      generator: vi.fn(async () => 'never'),
      writeHandover: vi.fn(),
      now: () => NOW,
    });
    expect(result.errors).toContain('skipped_lifecycle_speaking');
    expect(result.handover_written).toBeNull();
  });

  it('stamps last_grooming columns even when the LLM generator returns empty', async () => {
    insertWithChunks('bs-empty-summary', 12);
    const result = await runGroomingPass('mid', 'bs-empty-summary', {
      db,
      generator: vi.fn(async () => null),
      now: () => NOW,
    });
    expect(result.rolling_summary_written).toBe(false);
    const refreshed = db.getBrainstorm('bs-empty-summary')!;
    expect(refreshed.last_grooming_kind).toBe('mid');
    expect(refreshed.last_grooming_pass_at).toBeTruthy();
  });
});
