/**
 * Project-anchor seeding (PROJECT-ANCHORS.md `## Seeding`, line 57).
 *
 * Implements the `## Seeding` section of `docs/spec/PROJECT-ANCHORS.md`
 * which was specified but never built. On daemon boot (and on
 * `fs.watch` events against the projects root), enumerate top-level
 * subdirectories and upsert one `project_session` row per directory
 * keyed on `cwd`. Idempotent: re-running against a fully-seeded DB is
 * a no-op.
 *
 * The Projects root is `C:/dev/Projects` by default, overridable via
 * `DEVNEURAL_PROJECTS_ROOT`.
 *
 * Folders removed from disk are NOT auto-deleted from the anchor table
 * (per spec). The cleanup path is explicit user delete.
 *
 * Bridge-presence reconcile calls `ensureAnchorForCwd` inline when a
 * fresh presence file arrives for a cwd that has no seeded anchor.
 * This replaces the prior silent `if (!anchor) continue;` drop at
 * `bridge-presence.ts:243` which made VS Code bridges in newly created
 * directories invisible until the next boot pass.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IndexDb, ProjectSessionRow } from '../store/index-db.js';

export const DEFAULT_PROJECTS_ROOT = 'C:/dev/Projects';
export const PROJECTS_ROOT_ENV = 'DEVNEURAL_PROJECTS_ROOT';

export function getProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[PROJECTS_ROOT_ENV];
  if (raw && raw.trim()) {
    return normalizeCwd(raw.trim());
  }
  return DEFAULT_PROJECTS_ROOT;
}

export function normalizeCwd(cwd: string): string {
  /* Canonicalise the Windows drive letter to uppercase so the seeded
   * anchor cwd, the project registry root, and the bridge presence cwd
   * all compare equal. VS Code emits a lowercase drive ("c:/...") while
   * the default projects root is uppercase ("C:/dev/Projects"); without
   * this, a lowercase DEVNEURAL_PROJECTS_ROOT or a bridge-reported cwd
   * would split into a second anchor / never match. Must stay identical
   * to normalizeCwd in bridge-presence.ts. */
  return cwd
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
}

export interface SeedOptions {
  /** Override projects root. Defaults to DEVNEURAL_PROJECTS_ROOT env or C:/dev/Projects. */
  root?: string;
  /** Clock injection. Defaults to Date.now(). */
  now?: () => number;
  /** Optional log hook for boot diagnostics. */
  log?: (msg: string) => void;
}

export interface SeedResult {
  root: string;
  scanned: number;
  inserted: number;
  skipped: number;
  insertedIds: string[];
}

export function seedProjectAnchors(db: IndexDb, opts: SeedOptions = {}): SeedResult {
  const root = normalizeCwd(opts.root ?? getProjectsRoot());
  const now = opts.now ?? (() => Date.now());

  const result: SeedResult = {
    root,
    scanned: 0,
    inserted: 0,
    skipped: 0,
    insertedIds: [],
  };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    opts.log?.(`[seed-project-anchors] readdir ${root} failed: ${(err as Error).message}`);
    return result;
  }

  const nowMs = now();
  for (const entry of entries) {
    result.scanned++;
    if (!entry.isDirectory()) {
      result.skipped++;
      continue;
    }
    if (entry.name.startsWith('.')) {
      result.skipped++;
      continue;
    }
    const cwd = normalizeCwd(path.posix.join(root, entry.name));
    const created = ensureAnchorForCwd(db, cwd, {
      now: nowMs,
      projectSlug: entry.name,
    });
    if (created) {
      result.inserted++;
      result.insertedIds.push(created.id);
    } else {
      result.skipped++;
    }
  }

  opts.log?.(
    `[seed-project-anchors] root=${root} scanned=${result.scanned} inserted=${result.inserted} skipped=${result.skipped}`,
  );
  return result;
}

export interface EnsureAnchorOptions {
  now?: number;
  projectSlug?: string;
}

/**
 * Idempotent upsert helper: returns the newly created row, or null if
 * an anchor for that cwd already exists. Used by both the boot seed
 * loop and `bridge-presence.reconcileBridgePresence` for the inline
 * unknown-cwd create path.
 */
export function ensureAnchorForCwd(
  db: IndexDb,
  cwd: string,
  opts: EnsureAnchorOptions = {},
): ProjectSessionRow | null {
  const normalized = normalizeCwd(cwd);
  const existing = db.getProjectSessionByCwd(normalized);
  if (existing) return null;

  const slug = (opts.projectSlug ?? path.posix.basename(normalized)).trim() || 'unknown';
  const nowMs = opts.now ?? Date.now();
  const row: ProjectSessionRow = {
    id: randomUUID(),
    project_slug: slug,
    cwd: normalized,
    title: null,
    status: 'dormant',
    current_session_id: null,
    current_bridge_id: null,
    current_pty_id: null,
    created_ms: nowMs,
    last_seen_ms: nowMs,
  };
  db.insertProjectSession(row);
  return row;
}

export interface WatcherOptions {
  root?: string;
  debounceMs?: number;
  log?: (msg: string) => void;
  /** Test seam: override which seed function the watcher calls. */
  seed?: (db: IndexDb, opts: SeedOptions) => SeedResult;
}

/**
 * Watch the projects root for new top-level directories. Coarse
 * `fs.watch` with debounce; on every event we re-run the seed pass
 * (idempotent so a stray rename or temp-dir flap costs nothing).
 *
 * Returns a stop function; daemon shutdown should call it to release
 * the watcher handle.
 */
export function startProjectsRootWatcher(
  db: IndexDb,
  opts: WatcherOptions = {},
): () => void {
  const root = normalizeCwd(opts.root ?? getProjectsRoot());
  const debounceMs = opts.debounceMs ?? 1_500;
  const seedFn = opts.seed ?? seedProjectAnchors;

  let watcher: fs.FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  try {
    watcher = fs.watch(root, { persistent: false }, () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          seedFn(db, { root, log: opts.log });
        } catch (err) {
          opts.log?.(
            `[seed-project-anchors] watcher reseed failed: ${(err as Error).message}`,
          );
        }
      }, debounceMs);
    });
    watcher.on('error', (err) => {
      opts.log?.(`[seed-project-anchors] watcher error: ${err.message}`);
    });
    opts.log?.(`[seed-project-anchors] watching ${root} for new top-level dirs`);
  } catch (err) {
    opts.log?.(
      `[seed-project-anchors] fs.watch(${root}) failed: ${(err as Error).message}`,
    );
  }

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
    watcher = null;
  };
}
