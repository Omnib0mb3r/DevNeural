/**
 * Phase 4 of LEX-STANDALONE-SUPERVISION: cold-start preload prefers
 * the freshest HANDOVER doc over last_summary_ms when its mtime is
 * newer.
 *
 * Uses the findHandover dep injection so the test does not need to
 * write real HANDOVER files. The lookup contract is the same shape
 * the production default uses (findLatestHandover + fs.statSync).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-cold-handover-'));
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'EmptyProjectsRoot'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
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
  delete process.env.DEVNEURAL_DATA_ROOT;
  delete process.env.DEVNEURAL_PROJECTS_ROOT;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* tolerate windows file-lock races */
  }
});

function seedSibling(opts: {
  id: string;
  label: string;
  startedMs: number;
  lastSummaryMs: number | null;
}) {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: `/synthetic/${opts.id}`,
    user_label: opts.label,
    derived_label: null,
    mode: 'conversation',
    status: 'ended',
    started_ms: opts.startedMs,
    ended_ms: opts.startedMs + 60_000,
    turn_count: 2,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary:
      opts.lastSummaryMs === null ? null : `stub summary for ${opts.id}`,
    last_summary_ms: opts.lastSummaryMs,
  });
  /* Two chunks so countBrainstormChunks returns something useful */
  db.insertBrainstormChunk({
    id: `${opts.id}-c0`,
    brainstorm_id: opts.id,
    turn_index: 0,
    role: 'user',
    mode: 'conversation',
    text: 'sample',
    model_id: '',
    no_decay: 1,
  });
  db.insertBrainstormChunk({
    id: `${opts.id}-c1`,
    brainstorm_id: opts.id,
    turn_index: 1,
    role: 'lex',
    mode: 'conversation',
    text: 'reply',
    model_id: 'claude',
    no_decay: 1,
  });
}

describe('preloadColdStartSiblings handover preference (Phase 4)', () => {
  it('prefers HANDOVER mtime over last_summary_ms when handover is newer', async () => {
    const oldMs = 1_700_000_000_000;
    const newMs = oldMs + 30 * 60 * 1000;
    seedSibling({
      id: 'bs-with-handover',
      label: 'Lex Standalone Test',
      startedMs: oldMs,
      lastSummaryMs: oldMs,
    });
    const findHandover = vi.fn((id: string) => {
      if (id === 'bs-with-handover') {
        return { mtimeMs: newMs, filePath: `/synthetic/HANDOVER-${id}.md` };
      }
      return null;
    });
    const out = await preloadColdStartSiblings({
      db,
      generator: null,
      label: 'Lex Standalone Test',
      excludeId: 'bs-new-session',
      forceForTopN: 0,
      findHandover,
    });
    expect(out.last_distilled_ms).toBe(newMs);
    expect(out.handover_sourced_count).toBe(1);
    expect(findHandover).toHaveBeenCalledWith('bs-with-handover');
  });

  it('falls back to last_summary_ms when handover doc is older', async () => {
    const oldMs = 1_700_000_000_000;
    const summaryMs = oldMs + 60 * 60 * 1000;
    seedSibling({
      id: 'bs-stale-handover',
      label: 'Lex Standalone Test',
      startedMs: oldMs,
      lastSummaryMs: summaryMs,
    });
    const findHandover = vi.fn(() => ({
      mtimeMs: oldMs,
      filePath: '/x',
    }));
    const out = await preloadColdStartSiblings({
      db,
      generator: null,
      label: 'Lex Standalone Test',
      excludeId: 'bs-new-session',
      forceForTopN: 0,
      findHandover,
    });
    expect(out.last_distilled_ms).toBe(summaryMs);
    expect(out.handover_sourced_count).toBe(0);
  });

  it('uses handover mtime when last_summary_ms is null', async () => {
    const handoverMs = 1_700_000_000_000;
    seedSibling({
      id: 'bs-no-summary',
      label: 'Lex Standalone Test',
      startedMs: handoverMs - 60_000,
      lastSummaryMs: null,
    });
    const findHandover = vi.fn(() => ({
      mtimeMs: handoverMs,
      filePath: '/x',
    }));
    const out = await preloadColdStartSiblings({
      db,
      generator: null,
      label: 'Lex Standalone Test',
      excludeId: null,
      forceForTopN: 0,
      findHandover,
    });
    expect(out.last_distilled_ms).toBe(handoverMs);
    expect(out.handover_sourced_count).toBe(1);
  });

  it('falls back cleanly when findHandover throws', async () => {
    const summaryMs = 1_700_000_000_000;
    seedSibling({
      id: 'bs-throws',
      label: 'Lex Standalone Test',
      startedMs: summaryMs - 60_000,
      lastSummaryMs: summaryMs,
    });
    const findHandover = vi.fn(() => {
      throw new Error('disk unavailable');
    });
    const out = await preloadColdStartSiblings({
      db,
      generator: null,
      label: 'Lex Standalone Test',
      excludeId: null,
      forceForTopN: 0,
      findHandover,
    });
    expect(out.last_distilled_ms).toBe(summaryMs);
    expect(out.handover_sourced_count).toBe(0);
  });

  it('returns handover_sourced_count=0 when findHandover is not wired', async () => {
    seedSibling({
      id: 'bs-no-handover-dep',
      label: 'Lex Standalone Test',
      startedMs: 1_700_000_000_000,
      lastSummaryMs: 1_700_000_000_000,
    });
    const out = await preloadColdStartSiblings({
      db,
      generator: null,
      label: 'Lex Standalone Test',
      excludeId: null,
      forceForTopN: 0,
      /* findHandover intentionally omitted so the default production
       * lookup runs against the empty tmpDir handovers dir */
    });
    expect(out.handover_sourced_count).toBe(0);
    expect(out.last_distilled_ms).toBe(1_700_000_000_000);
  });
});
