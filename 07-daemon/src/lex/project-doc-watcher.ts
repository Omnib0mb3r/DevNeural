/**
 * Incremental knowledge-index watcher (Unified Knowledge Index, part 2A).
 *
 * Watches a project's markdown store dirs and re-indexes ONE file at a
 * time when it changes / is added / is deleted, so "where is X" stays
 * current within seconds without a full manual re-index. Reuses the
 * per-file primitives in project-doc-index (reindexDocFile / removeDocFile)
 * and the existing chunker + embed path; only the changed file's chunks
 * are touched.
 *
 * Two layers, split so the logic is testable without real fs.watch:
 *   - createDocWatchCoordinator: the pure-ish debounce + dispatch core.
 *     notify(path) coalesces a burst of edits to one re-index per file,
 *     resolves which store a path belongs to, and routes exists -> reindex
 *     vs gone -> remove, then flushes. All side effects (timers, fs,
 *     reindex/remove, flush) are injected.
 *   - startProjectDocWatch: the thin production shell that wires real
 *     fs.watch on each store dir into the coordinator.
 *
 * Strict project scope is preserved: the coordinator is built for ONE
 * project_id and only ever reindexes/removes that project's chunks.
 *
 * Additive: nothing here runs unless a caller starts a watcher. It does
 * not touch the existing index, recall, or any regression-guard surface.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import type { Store } from '../store/index.js';
import {
  reindexDocFile,
  removeDocFile,
  type DocIndexDeps,
} from './project-doc-index.js';
import type { MarkdownStoreSpec } from './markdown-corpus.js';

/* Coalesce window for rapid edits to one file. Editors fire several
 * change events per save (truncate + write + metadata); 750ms folds a
 * burst into a single re-index while still landing "within seconds". */
const DEFAULT_DEBOUNCE_MS = 750;

type TimerHandle = unknown;

export interface DocWatchDeps {
  /** Re-index one existing file under the resolved store label. */
  reindexFile: (path: string, storeLabel: string) => Promise<void>;
  /** Remove a deleted file's chunks. */
  removeFile: (path: string) => void;
  /** True when the path still exists on disk (change/add vs delete). */
  exists: (path: string) => boolean;
  /** Persist after applying a change. */
  flush: () => Promise<void> | void;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (h: TimerHandle) => void;
  debounceMs?: number;
  log?: (msg: string) => void;
}

export interface DocWatchCoordinator {
  /** Feed a (possibly noisy) filesystem path. Non-markdown paths and
   * paths outside every watched store are ignored. */
  notify(fullPath: string): void;
  /** Cancel pending timers; stop accepting events. */
  close(): void;
}

interface NormStore {
  store: string;
  dir: string;
  recursive: boolean;
}

function normStores(stores: MarkdownStoreSpec[]): NormStore[] {
  return stores.map((s) => ({
    store: s.store,
    dir: s.dir.replace(/\\/g, '/').replace(/\/+$/, ''),
    recursive: s.recursive ?? false,
  }));
}

/* Resolve which store a path belongs to. Longest matching dir wins (so a
 * nested store like docs/spec under a recursive docs is attributed to the
 * more specific one). For a non-recursive store the file must be a direct
 * child. Returns the store label, or null when the path is outside every
 * watched store. */
function resolveStoreLabel(norm: NormStore[], fullPath: string): string | null {
  let best: NormStore | null = null;
  for (const s of norm) {
    if (!fullPath.startsWith(s.dir + '/')) continue;
    const rest = fullPath.slice(s.dir.length + 1);
    if (!s.recursive && rest.includes('/')) continue;
    if (!best || s.dir.length > best.dir.length) best = s;
  }
  return best ? best.store : null;
}

export function createDocWatchCoordinator(
  stores: MarkdownStoreSpec[],
  deps: DocWatchDeps,
): DocWatchCoordinator {
  const norm = normStores(stores);
  const debounce = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pending = new Map<string, TimerHandle>();
  let closed = false;

  async function settle(path: string, label: string): Promise<void> {
    try {
      if (deps.exists(path)) {
        await deps.reindexFile(path, label);
      } else {
        deps.removeFile(path);
      }
      await deps.flush();
    } catch (err) {
      deps.log?.(
        `[doc-watch] settle failed for ${path}: ${(err as Error).message}`,
      );
    }
  }

  function notify(fullPath: string): void {
    if (closed) return;
    const p = fullPath.replace(/\\/g, '/');
    if (!/\.md$/i.test(p)) return;
    const label = resolveStoreLabel(norm, p);
    if (!label) return;
    const existing = pending.get(p);
    if (existing !== undefined) deps.clearTimer(existing);
    const h = deps.setTimer(() => {
      pending.delete(p);
      void settle(p, label);
    }, debounce);
    pending.set(p, h);
  }

  function close(): void {
    closed = true;
    for (const h of pending.values()) deps.clearTimer(h);
    pending.clear();
  }

  return { notify, close };
}

export interface StartDocWatchParams {
  project_id: string;
  stores: MarkdownStoreSpec[];
}

export type StartDocWatchDeps = Partial<DocIndexDeps> & {
  readFile?: (p: string) => string | null;
  debounceMs?: number;
  log?: (msg: string) => void;
};

/* Production entry: wire real fs.watch on each store dir into the
 * coordinator. Returns the coordinator; call close() to tear down. A
 * missing store dir is skipped (logged), never thrown. */
export function startProjectDocWatch(
  store: Store,
  params: StartDocWatchParams,
  deps?: StartDocWatchDeps,
): DocWatchCoordinator {
  const coord = createDocWatchCoordinator(params.stores, {
    reindexFile: async (path, label) => {
      await reindexDocFile(
        store,
        { project_id: params.project_id, store: label, path },
        deps,
      );
    },
    removeFile: (path) => {
      removeDocFile(store, params.project_id, path);
    },
    exists: (p) => nodeFs.existsSync(p),
    flush: () => store.rawChunks.flush(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    debounceMs: deps?.debounceMs,
    log: deps?.log,
  });

  const watchers: nodeFs.FSWatcher[] = [];
  for (const spec of params.stores) {
    const dir = spec.dir.replace(/\\/g, '/');
    try {
      const w = nodeFs.watch(
        dir,
        { recursive: spec.recursive ?? false },
        (_event, filename) => {
          if (!filename) return;
          const rel = String(filename).replace(/\\/g, '/');
          coord.notify(nodePath.posix.join(dir, rel));
        },
      );
      watchers.push(w);
    } catch (err) {
      deps?.log?.(
        `[doc-watch] cannot watch ${dir}: ${(err as Error).message}`,
      );
    }
  }

  return {
    notify: coord.notify,
    close: () => {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* best-effort */
        }
      }
      coord.close();
    },
  };
}
