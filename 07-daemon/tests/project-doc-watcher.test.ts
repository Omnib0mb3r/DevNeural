/**
 * Incremental knowledge-index watcher (DRIVE-QUEUE 2A). Pins the debounce
 * + dispatch core with injected timers/fs: a burst of edits coalesces to
 * one re-index, an existing file routes to reindex, a deleted file routes
 * to remove, and non-markdown / out-of-store paths are ignored. The real
 * fs.watch wiring is a thin shell over this core.
 */
import { describe, expect, it } from 'vitest';
import {
  createDocWatchCoordinator,
  type DocWatchDeps,
} from '../src/lex/project-doc-watcher.js';
import type { MarkdownStoreSpec } from '../src/lex/markdown-corpus.js';

const STORES: MarkdownStoreSpec[] = [
  { store: 'docs', dir: '/proj/docs', recursive: true },
  { store: 'memory', dir: '/proj/memory' },
];

interface Harness {
  deps: DocWatchDeps;
  fire: () => void;
  pendingCount: () => number;
  reindexed: Array<{ path: string; label: string }>;
  removed: string[];
  flushes: number;
}

function harness(exists: (p: string) => boolean): Harness {
  let seq = 0;
  const scheduled = new Map<number, () => void>();
  const reindexed: Array<{ path: string; label: string }> = [];
  const removed: string[] = [];
  let flushes = 0;
  const deps: DocWatchDeps = {
    reindexFile: async (path, label) => {
      reindexed.push({ path, label });
    },
    removeFile: (path) => {
      removed.push(path);
    },
    exists,
    flush: () => {
      flushes += 1;
    },
    setTimer: (fn) => {
      const id = ++seq;
      scheduled.set(id, fn);
      return id;
    },
    clearTimer: (h) => {
      scheduled.delete(h as number);
    },
    debounceMs: 750,
  };
  return {
    deps,
    fire: () => {
      const fns = [...scheduled.values()];
      scheduled.clear();
      for (const f of fns) f();
    },
    pendingCount: () => scheduled.size,
    reindexed,
    removed,
    flushes,
  };
}

/* Let the async settle() microtasks drain after firing a timer. */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('createDocWatchCoordinator', () => {
  it('debounce coalesces a burst of edits to one re-index', async () => {
    const h = harness(() => true);
    const c = createDocWatchCoordinator(STORES, h.deps);
    /* Five rapid events on the same file (editor save churn). */
    for (let i = 0; i < 5; i++) c.notify('/proj/docs/a.md');
    expect(h.pendingCount()).toBe(1); // prior timers cancelled
    h.fire();
    await tick();
    expect(h.reindexed).toHaveLength(1);
    expect(h.reindexed[0]).toEqual({ path: '/proj/docs/a.md', label: 'docs' });
  });

  it('an existing file routes to reindex under its resolved store', async () => {
    const h = harness(() => true);
    const c = createDocWatchCoordinator(STORES, h.deps);
    c.notify('/proj/docs/sub/deep.md'); // recursive store
    c.notify('/proj/memory/m.md'); // flat store
    h.fire();
    await tick();
    expect(h.reindexed).toEqual([
      { path: '/proj/docs/sub/deep.md', label: 'docs' },
      { path: '/proj/memory/m.md', label: 'memory' },
    ]);
    expect(h.removed).toEqual([]);
  });

  it('a deleted file routes to remove', async () => {
    const h = harness(() => false); // path no longer exists
    const c = createDocWatchCoordinator(STORES, h.deps);
    c.notify('/proj/docs/gone.md');
    h.fire();
    await tick();
    expect(h.removed).toEqual(['/proj/docs/gone.md']);
    expect(h.reindexed).toEqual([]);
  });

  it('ignores non-markdown, out-of-store, and non-recursive-subdir paths', async () => {
    const h = harness(() => true);
    const c = createDocWatchCoordinator(STORES, h.deps);
    c.notify('/proj/docs/notes.txt'); // not markdown
    c.notify('/other/docs/x.md'); // outside every store
    c.notify('/proj/memory/sub/deep.md'); // memory is non-recursive
    expect(h.pendingCount()).toBe(0); // nothing scheduled
    h.fire();
    await tick();
    expect(h.reindexed).toEqual([]);
    expect(h.removed).toEqual([]);
  });

  it('close() cancels pending timers and stops accepting events', async () => {
    const h = harness(() => true);
    const c = createDocWatchCoordinator(STORES, h.deps);
    c.notify('/proj/docs/a.md');
    expect(h.pendingCount()).toBe(1);
    c.close();
    expect(h.pendingCount()).toBe(0); // pending timer cleared
    c.notify('/proj/docs/b.md'); // ignored after close
    expect(h.pendingCount()).toBe(0);
  });

  it('distinct files debounce independently', async () => {
    const h = harness(() => true);
    const c = createDocWatchCoordinator(STORES, h.deps);
    c.notify('/proj/docs/a.md');
    c.notify('/proj/docs/b.md');
    expect(h.pendingCount()).toBe(2);
    h.fire();
    await tick();
    expect(h.reindexed.map((r) => r.path).sort()).toEqual([
      '/proj/docs/a.md',
      '/proj/docs/b.md',
    ]);
  });
});
