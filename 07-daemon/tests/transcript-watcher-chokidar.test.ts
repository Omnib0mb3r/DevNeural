/**
 * Regression test for the chokidar v4 glob-removal outage.
 *
 * chokidar v4.0.3 dropped glob-string support. transcript-watcher.ts used
 * to call chokidar.watch(`${root}/**\/*.jsonl`, ...), which chokidar v4
 * treats as a literal (nonexistent) path: the watcher binds and reports
 * ready but never fires 'add'/'change' for real session files. Every
 * downstream stage (transcripts.jsonl, auto-ingest, lint-queue) starved
 * silently for ~65 days as a result.
 *
 * The fix mirrors src/dashboard/worker-event-listener.ts's own "Fix 34b":
 * watch the root directory itself and filter to .jsonl files via the
 * `ignored` predicate. These tests assert (a) chokidar.watch is called
 * with the plain root directory string, never a glob, and (b) the
 * exported filter predicate accepts real session jsonl paths and rejects
 * everything else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// vi.mock(...) below is hoisted above ordinary top-level statements, so
// the mock fns it closes over must be created via vi.hoisted() (which is
// hoisted even earlier) -- plain `const mockWatch = vi.fn()` here would
// hit a TDZ ReferenceError when the factory runs.
const { mockWatch, mockWatcherOn, mockWatcherClose } = vi.hoisted(() => ({
  mockWatch: vi.fn(),
  mockWatcherOn: vi.fn(),
  mockWatcherClose: vi.fn(async () => undefined),
}));

vi.mock('chokidar', () => {
  const fakeWatcher = {
    on: (...args: unknown[]) => {
      mockWatcherOn(...args);
      return fakeWatcher;
    },
    close: mockWatcherClose,
  };
  const watch = (...args: unknown[]) => {
    mockWatch(...args);
    return fakeWatcher;
  };
  return {
    default: { watch, FSWatcher: class {} },
    watch,
    FSWatcher: class {},
  };
});

import {
  startTranscriptWatcher,
  isIgnoredTranscriptPath,
} from '../src/capture/transcript-watcher.js';

let tmpDir: string;
let root: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-tw-chokidar-'));
  root = path.posix.join(tmpDir.replace(/\\/g, '/'), 'projects');
  fs.mkdirSync(root, { recursive: true });
  mockWatch.mockClear();
  mockWatcherOn.mockClear();
  mockWatcherClose.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('startTranscriptWatcher chokidar wiring', () => {
  it('passes the plain root directory to chokidar.watch, never a glob', async () => {
    const logs: string[] = [];
    const handle = startTranscriptWatcher({ rootDir: root, log: (m) => logs.push(m) });

    expect(mockWatch).toHaveBeenCalledTimes(1);
    const [watchedPath, watchOptions] = mockWatch.mock.calls[0]!;

    // The historical bug: watchedPath used to be `${root}/**/*.jsonl`.
    expect(watchedPath).toBe(root);
    expect(String(watchedPath)).not.toContain('*');

    // depth:1 bounds recursion to root -> <slug>/ -> <uuid>.jsonl.
    expect((watchOptions as { depth?: number }).depth).toBe(1);
    // ignoreInitial:true so the boot catch-up scan (tested separately)
    // owns the backlog instead of racing chokidar's own initial 'add'
    // sweep over the same files.
    expect((watchOptions as { ignoreInitial?: boolean }).ignoreInitial).toBe(true);
    expect(typeof (watchOptions as { ignored?: unknown }).ignored).toBe('function');

    expect(mockWatcherOn).toHaveBeenCalledWith('add', expect.any(Function));
    expect(mockWatcherOn).toHaveBeenCalledWith('change', expect.any(Function));
    expect(mockWatcherOn).toHaveBeenCalledWith('error', expect.any(Function));

    expect(logs.some((l) => l.includes('boot: root=') && l.includes('mode='))).toBe(true);

    await handle.stop();
    expect(mockWatcherClose).toHaveBeenCalledTimes(1);
  });

  it('does not touch chokidar when the root directory does not exist', () => {
    const missingRoot = path.posix.join(root, 'does-not-exist');
    const logs: string[] = [];
    startTranscriptWatcher({ rootDir: missingRoot, log: (m) => logs.push(m) });
    expect(mockWatch).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('root not present'))).toBe(true);
  });
});

describe('isIgnoredTranscriptPath', () => {
  it('accepts <root>/<slug>/<uuid>.jsonl files', () => {
    const stat = { isFile: () => true } as fs.Stats;
    const p = `${root}/proj-slug/1111-2222-3333-4444.jsonl`;
    expect(isIgnoredTranscriptPath(p, stat)).toBe(false);
  });

  it('rejects non-jsonl files', () => {
    const stat = { isFile: () => true } as fs.Stats;
    expect(isIgnoredTranscriptPath(`${root}/proj-slug/notes.txt`, stat)).toBe(true);
    expect(isIgnoredTranscriptPath(`${root}/proj-slug/session.json`, stat)).toBe(true);
    expect(isIgnoredTranscriptPath(`${root}/proj-slug/.DS_Store`, stat)).toBe(true);
  });

  it('never ignores directories, regardless of name', () => {
    const dirStat = { isFile: () => false } as fs.Stats;
    expect(isIgnoredTranscriptPath(`${root}/proj-slug`, dirStat)).toBe(false);
  });

  it('does not ignore when stats are unavailable (chokidar pre-stat call)', () => {
    expect(isIgnoredTranscriptPath(`${root}/proj-slug/x.jsonl`, undefined)).toBe(false);
  });
});
