import * as fs from 'node:fs';
import { ensureDataRoot, projectsRegistry, projectMetaFile, ensureProjectDir } from '../paths.js';
import type { ProjectIdentity, ProjectRegistryEntry } from '../types.js';

interface RegistryFile {
  version: 1;
  projects: Record<string, ProjectRegistryEntry>;
}

function loadRegistry(): RegistryFile {
  ensureDataRoot();
  const file = projectsRegistry();
  if (!fs.existsSync(file)) {
    return { version: 1, projects: {} };
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as RegistryFile;
    if (parsed.version !== 1 || typeof parsed.projects !== 'object') {
      return { version: 1, projects: {} };
    }
    return parsed;
  } catch {
    return { version: 1, projects: {} };
  }
}

function saveRegistry(reg: RegistryFile): void {
  fs.writeFileSync(projectsRegistry(), JSON.stringify(reg, null, 2), 'utf-8');
}

/* Root comparison key. Same normalization the dashboard uses to join
 * anchors to project tiles (lowercased, forward-slashed, no trailing
 * slash) so a path-scoped and a remote-scoped entry for the identical
 * folder compare equal regardless of casing or slash direction. */
function normalizeRoot(root: string | undefined): string {
  return (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/* Reconcile path-vs-remote duplicates for one folder (2026-07-23).
 *
 * Identity ids are hashed from the git remote when one exists, else
 * from the path (see resolveProjectIdentity). A project created folder-
 * first and given its git remote seconds later therefore registers
 * TWICE: once path-scoped (remote null) before the remote existed, once
 * remote-scoped after. Both point at the same root, so the startable
 * list shows the folder twice (observed: two "John Simms").
 *
 * When we record a REMOTE identity, fold any path-scoped entry for the
 * same root into it: carry the earlier first_seen, drop the orphan.
 * The remote id is the durable one (stable across clones), so it wins.
 * Returns the ids removed so the caller can log/observe. Mutates reg in
 * place; the caller saves. */
function reconcilePathDupes(
  identity: ProjectIdentity,
  reg: RegistryFile,
): string[] {
  if (!identity.remote) return [];
  const targetRoot = normalizeRoot(identity.root);
  if (!targetRoot) return [];
  const removed: string[] = [];
  for (const [id, entry] of Object.entries(reg.projects)) {
    if (id === identity.id) continue;
    if (entry.remote) continue; // only collapse path-scoped orphans
    if (normalizeRoot(entry.root) !== targetRoot) continue;
    // Preserve the earliest first_seen on the surviving remote entry.
    const survivor = reg.projects[identity.id];
    if (
      survivor &&
      entry.first_seen &&
      (!survivor.first_seen || entry.first_seen < survivor.first_seen)
    ) {
      survivor.first_seen = entry.first_seen;
    }
    delete reg.projects[id];
    removed.push(id);
  }
  return removed;
}

export function recordIdentity(identity: ProjectIdentity): void {
  if (identity.id === 'global') return;
  const now = new Date().toISOString();
  const reg = loadRegistry();
  const existing = reg.projects[identity.id];
  if (existing) {
    existing.last_seen = now;
    if (existing.name !== identity.name) existing.name = identity.name;
    if (existing.root !== identity.root) existing.root = identity.root;
    if (existing.remote !== identity.remote) existing.remote = identity.remote;
  } else {
    reg.projects[identity.id] = {
      id: identity.id,
      name: identity.name,
      root: identity.root,
      remote: identity.remote,
      first_seen: now,
      last_seen: now,
    };
  }
  /* Collapse the pre-remote path-scoped orphan(s) for this folder, if
   * any. No-op for path-scoped registrations and for folders that were
   * always remote-scoped. */
  const removed = reconcilePathDupes(identity, reg);
  if (removed.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[registry] reconciled ${removed.length} path-scoped dupe(s) into ${identity.id} for root ${identity.root}: ${removed.join(', ')}`,
    );
  }
  saveRegistry(reg);

  ensureProjectDir(identity.id);
  fs.writeFileSync(
    projectMetaFile(identity.id),
    JSON.stringify(reg.projects[identity.id], null, 2),
    'utf-8',
  );
}

/* One-time sweep over the whole registry (2026-07-23). Applies the
 * same path-vs-remote collapse reconcilePathDupes does, but across
 * every existing remote-scoped entry, so dupes registered BEFORE the
 * reconcile logic landed (e.g. the two "John Simms") heal on the next
 * daemon boot without waiting for a fresh session in that folder.
 * Idempotent: a clean registry returns { removed: [] } and writes
 * nothing. Called once from daemon boot. */
export function reconcileAllProjects(): { removed: string[] } {
  const reg = loadRegistry();
  const removedAll: string[] = [];
  for (const entry of Object.values(reg.projects)) {
    if (!entry.remote) continue;
    const removed = reconcilePathDupes(
      {
        id: entry.id,
        name: entry.name,
        root: entry.root,
        remote: entry.remote,
      } as ProjectIdentity,
      reg,
    );
    removedAll.push(...removed);
  }
  if (removedAll.length > 0) saveRegistry(reg);
  return { removed: removedAll };
}

/* Prune registry entries whose root folder no longer exists on disk
 * (2026-07-23). Covers deleted projects and path-scoped renames (folder
 * moved -> old path stale -> a fresh session under the new path
 * re-registers a new entry, leaving the old one broken). A stale entry
 * can only mislead: Start Claude on it opens a path that isn't there.
 * git-remote-scoped renames self-heal instead (same remote -> same id
 * -> recordIdentity rewrites root on the next capture), so this only
 * ever removes genuinely dead folders. Skipped for any entry whose root
 * is empty (never resolved) to avoid nuking half-written rows. Called
 * once from daemon boot, after reconcileAllProjects. */
export function pruneMissingProjects(): { removed: string[] } {
  const reg = loadRegistry();
  const removed: string[] = [];
  for (const [id, entry] of Object.entries(reg.projects)) {
    if (!entry.root) continue;
    if (fs.existsSync(entry.root)) continue;
    delete reg.projects[id];
    removed.push(id);
  }
  if (removed.length > 0) saveRegistry(reg);
  return { removed };
}

export function listProjects(): ProjectRegistryEntry[] {
  return Object.values(loadRegistry().projects);
}

export function getProject(id: string): ProjectRegistryEntry | undefined {
  return loadRegistry().projects[id];
}
