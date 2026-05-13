/**
 * Sticky cc_session_id latch regression suite.
 *
 * Covers TODO.md bug #2 (2026-05-13): the 30s mtime-window scan was
 * dropping the bridge's cc_session_ids the moment a worker terminal
 * went idle for more than 30 seconds. The CcSessionLatch latches the
 * newest jsonl UUID per cwd and keeps reporting it until either
 * deactivate clear() or a newer UUID supersedes on disk; these tests
 * pin every transition so the regression cannot return.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CcSessionLatch } from '../src/cc-session-latch.js';

let root: string;
const CWD = 'C:/dev/Projects/DevNeural';
const SLUG = 'C--dev-Projects-DevNeural';

function writeJsonl(uuid: string, mtimeMs: number, slug = SLUG): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(full, '');
  /* fs.utimes accepts seconds; preserve the millisecond delta we
   * care about as best we can. */
  const t = mtimeMs / 1000;
  fs.utimesSync(full, t, t);
  return full;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-session-latch-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('CcSessionLatch.resolve', () => {
  it('returns undefined when no jsonl exists for the cwd', () => {
    const latch = new CcSessionLatch({ claudeProjectsRoot: root });
    expect(latch.resolve(CWD)).toBeUndefined();
  });

  it('latches the newest jsonl by mtime on first call', () => {
    writeJsonl('aaa', Date.now() - 60_000);
    writeJsonl('bbb', Date.now() - 10_000);
    const latch = new CcSessionLatch({ claudeProjectsRoot: root });
    expect(latch.resolve(CWD)).toBe('bbb');
  });

  it('keeps returning the latched UUID after the worker goes idle past the old 30s window', () => {
    /* Simulate a worker that wrote a turn 5 minutes ago and has been
     * silent since. The old freshness-gate scan would drop the UUID;
     * the latch must keep it. */
    writeJsonl('idle', Date.now() - 5 * 60_000);
    const latch = new CcSessionLatch({ claudeProjectsRoot: root });
    expect(latch.resolve(CWD)).toBe('idle');
    /* Ten seconds later, no fresh writes anywhere. */
    expect(latch.resolve(CWD)).toBe('idle');
  });

  it('supersedes when a newer jsonl UUID appears with a newer mtime', () => {
    writeJsonl('old', Date.now() - 60_000);
    const latch = new CcSessionLatch({ claudeProjectsRoot: root });
    expect(latch.resolve(CWD)).toBe('old');
    writeJsonl('new', Date.now() - 1_000);
    expect(latch.resolve(CWD)).toBe('new');
  });

  it('keeps the latch when the same UUID is touched again (mtime refresh)', () => {
    const initialMtime = Date.now() - 60_000;
    const fileA = writeJsonl('only', initialMtime);
    const latch = new CcSessionLatch({ claudeProjectsRoot: root });
    expect(latch.resolve(CWD)).toBe('only');
    /* Same UUID, fresher mtime — the worker just wrote another turn. */
    const refreshed = Date.now();
    fs.utimesSync(fileA, refreshed / 1000, refreshed / 1000);
    expect(latch.resolve(CWD)).toBe('only');
    const snap = latch.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.entry.mtimeMs).toBeGreaterThanOrEqual(initialMtime);
  });

  it('returns the prior latch when the slug dir disappears mid-session', () => {
    writeJsonl('survivor', Date.now() - 1_000);
    const latch = new CcSessionLatch({ claudeProjectsRoot: root });
    expect(latch.resolve(CWD)).toBe('survivor');
    /* Wipe the slug dir to simulate a transient filesystem hiccup. */
    fs.rmSync(path.join(root, SLUG), { recursive: true, force: true });
    expect(latch.resolve(CWD)).toBe('survivor');
  });

  it('resolves a case-mismatched slug dir on case-sensitive filesystems', () => {
    /* Filesystems vary; emulate the case-sensitive path by writing
     * under a lowercase variant and querying the canonical cwd. */
    const lower = SLUG.toLowerCase();
    writeJsonl('caseHit', Date.now() - 1_000, lower);
    const latch = new CcSessionLatch({ claudeProjectsRoot: root });
    expect(latch.resolve(CWD)).toBe('caseHit');
  });

  it('clear() drops every latched entry', () => {
    writeJsonl('toBeForgotten', Date.now() - 1_000);
    const latch = new CcSessionLatch({ claudeProjectsRoot: root });
    expect(latch.resolve(CWD)).toBe('toBeForgotten');
    latch.clear();
    expect(latch.snapshot()).toHaveLength(0);
  });
});
