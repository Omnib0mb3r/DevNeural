/**
 * Task 4 of the capture-pipeline revival: lint-queue's cycle() used to
 * only regenerate whats-new.md / run decay when a lint pass produced
 * actions.length > 0. That's correct for avoiding needless writes on a
 * quiet wiki, but it also meant whats-new.md could go stale indefinitely
 * on a genuinely quiet wiki (which is exactly what happened during the
 * chokidar outage: nothing new landed to lint, so the Daily Brief sat 66
 * days stale even after the pipeline was revived, since a quiet cycle
 * never re-ran the digest).
 *
 * Fix: a quiet cycle (zero actions) still triggers decay + whats-new
 * once whats-new.md's mtime is 24h+ old (or missing). These tests mock
 * lint-queue's dependencies directly so they don't need a real wiki
 * fixture, and control staleness via a real temp file's mtime rather
 * than reaching into module internals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Store } from '../src/store/index.js';

let mockWhatsNewPath: string;

const mockRunLint = vi.fn();
const mockGenerateWhatsNew = vi.fn();
const mockDecayInactivePages = vi.fn(async () => ({ decayed: 0, archived: 0 }));

vi.mock('../src/wiki/lint.js', () => ({
  runLint: (...args: unknown[]) => mockRunLint(...args),
}));
vi.mock('../src/wiki/whats-new.js', () => ({
  generateWhatsNew: (...args: unknown[]) => mockGenerateWhatsNew(...args),
}));
vi.mock('../src/reinforcement/index.js', () => ({
  decayInactivePages: (...args: unknown[]) => mockDecayInactivePages(...args),
}));
vi.mock('../src/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/paths.js')>();
  return { ...actual, wikiWhatsNewFile: () => mockWhatsNewPath };
});

import { initLintQueue, scheduleLint, lintQueueStatus } from '../src/wiki/lint-queue.js';

const STORE = {} as Store;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-lintq-'));
  mockWhatsNewPath = path.join(tmpDir, 'whats-new.md');
  mockRunLint.mockReset();
  mockGenerateWhatsNew.mockReset();
  mockDecayInactivePages.mockReset();
  mockDecayInactivePages.mockResolvedValue({ decayed: 0, archived: 0 });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Debounce is 0ms in these tests but still crosses a macrotask; poll
 * lintQueueStatus() until the cycle has finished rather than guessing a
 * fixed sleep. */
async function waitForCycleToFinish(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const status = lintQueueStatus();
    if (!status.running && !status.pending) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('lint-queue cycle did not finish in time');
}

describe('lint-queue quiet-cycle whats-new staleness refresh', () => {
  it('does NOT regenerate whats-new on a quiet cycle when it is fresh (< 24h)', async () => {
    mockRunLint.mockResolvedValue({ scanned: 3, actions: [] });
    fs.writeFileSync(mockWhatsNewPath, '# fresh', 'utf-8'); // mtime = now

    const logs: string[] = [];
    initLintQueue(STORE, (m) => logs.push(m), { debounceMs: 0 });
    scheduleLint('test-quiet-fresh');
    await waitForCycleToFinish();

    expect(mockRunLint).toHaveBeenCalledTimes(1);
    expect(mockGenerateWhatsNew).not.toHaveBeenCalled();
    expect(mockDecayInactivePages).not.toHaveBeenCalled();
  });

  it('DOES regenerate whats-new + run decay on a quiet cycle when it is stale (>= 24h)', async () => {
    mockRunLint.mockResolvedValue({ scanned: 3, actions: [] });
    fs.writeFileSync(mockWhatsNewPath, '# stale', 'utf-8');
    const oldMtime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    fs.utimesSync(mockWhatsNewPath, oldMtime, oldMtime);

    const logs: string[] = [];
    initLintQueue(STORE, (m) => logs.push(m), { debounceMs: 0 });
    scheduleLint('test-quiet-stale');
    await waitForCycleToFinish();

    expect(mockRunLint).toHaveBeenCalledTimes(1);
    expect(mockGenerateWhatsNew).toHaveBeenCalledTimes(1);
    expect(mockGenerateWhatsNew).toHaveBeenCalledWith(7);
    expect(mockDecayInactivePages).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes('whats-new regenerated') && l.includes('stale'))).toBe(
      true,
    );
  });

  it('DOES regenerate whats-new on a quiet cycle when whats-new.md has never been generated', async () => {
    mockRunLint.mockResolvedValue({ scanned: 0, actions: [] });
    // mockWhatsNewPath deliberately never written -> whatsNewIsStale()
    // treats a missing file as stale.

    initLintQueue(STORE, () => undefined, { debounceMs: 0 });
    scheduleLint('test-quiet-never-generated');
    await waitForCycleToFinish();

    expect(mockGenerateWhatsNew).toHaveBeenCalledTimes(1);
  });

  it('still regenerates whats-new when a cycle has actions, regardless of staleness', async () => {
    mockRunLint.mockResolvedValue({ scanned: 3, actions: [{ id: 'a1' }] });
    fs.writeFileSync(mockWhatsNewPath, '# fresh', 'utf-8'); // mtime = now, NOT stale

    initLintQueue(STORE, () => undefined, { debounceMs: 0 });
    scheduleLint('test-actions-present');
    await waitForCycleToFinish();

    expect(mockGenerateWhatsNew).toHaveBeenCalledTimes(1);
    expect(mockDecayInactivePages).toHaveBeenCalledTimes(1);
  });
});
