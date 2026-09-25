import * as fs from 'node:fs';
import {
  ensureDataRoot,
  projectsRegistry,
  projectsRoot,
  projectMetaFile,
  ensureProjectDir,
} from '../paths.js';
import type { ProjectIdentity, ProjectRegistryEntry } from '../types.js';

interface RegistryFile {
  version: 1;
  projects: Record<string, ProjectRegistryEntry>;
}

/* BUG-043 (2026-09-24): the registry kept collapsing to one or two
 * entries (DevNeural's first_seen reset on 2026-07-15 and again on
 * 2026-09-23 while the per-project meta dir holds 52 projects). Two
 * processes wrote projects.json: the daemon, and every Claude Code hook
 * invocation (hook-runner called recordIdentity directly on every
 * captured phase). writeFileSync truncates then writes, so a reader
 * that landed in the other process's truncate window got an empty file,
 * loadRegistry silently answered "no projects", and the next save wrote
 * a registry containing only the caller's project. Three fixes:
 *   1. saves are atomic (temp file + rename), so no reader ever sees a
 *      half-written registry;
 *   2. an unreadable registry is never treated as empty: it is
 *      quarantined and rebuilt from the per-project meta files
 *      (projects/<id>/project.json, written on every registration);
 *   3. the hook process no longer writes the registry at all; it posts
 *      the identity to the daemon, the single writer (see hook-runner
 *      and POST /projects/record-identity). */
let registryLog: (msg: string) => void = (msg) => {
  // eslint-disable-next-line no-console
  console.error(msg);
};

/** The daemon routes registry warnings into daemon.log; the hook
 * process and tests keep the stderr default. */
export function setRegistryLogger(fn: (msg: string) => void): void {
  registryLog = fn;
}

function isEntry(v: unknown): v is ProjectRegistryEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.name === 'string' &&
    typeof e.root === 'string' &&
    (e.remote === null || typeof e.remote === 'string') &&
    typeof e.first_seen === 'string' &&
    typeof e.last_seen === 'string'
  );
}

function readRegistryFile(file: string): RegistryFile | 'missing' | 'corrupt' {
  if (!fs.existsSync(file)) return 'missing';
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    if (raw.trim().length === 0) return 'corrupt';
    const parsed = JSON.parse(raw) as RegistryFile;
    if (
      parsed.version !== 1 ||
      typeof parsed.projects !== 'object' ||
      parsed.projects === null
    ) {
      return 'corrupt';
    }
    return parsed;
  } catch {
    return 'corrupt';
  }
}

function loadRegistry(): RegistryFile {
  ensureDataRoot();
  const file = projectsRegistry();
  const read = readRegistryFile(file);
  if (read === 'missing') return { version: 1, projects: {} };
  if (read !== 'corrupt') return read;
  /* Quarantine the bytes for forensics, then rebuild from the meta
   * files instead of starting empty. The rebuilt registry is saved so
   * the next reader (and the next crash) starts from something whole. */
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantine = `${file}.corrupt-${stamp}`;
  try {
    fs.copyFileSync(file, quarantine);
  } catch {
    /* best-effort */
  }
  const reg: RegistryFile = { version: 1, projects: {} };
  const restored = restoreFromProjectMeta(reg);
  registryLog(
    `[registry] projects.json unreadable; quarantined to ${quarantine}; rebuilt ${restored.length} entr(y/ies) from per-project meta (BUG-043)`,
  );
  saveRegistry(reg);
  return reg;
}

function saveRegistry(reg: RegistryFile): void {
  const file = projectsRegistry();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf-8');
  /* rename replaces the target atomically on the same volume (NTFS
   * MoveFileEx with REPLACE_EXISTING), so a concurrent reader sees the
   * old bytes or the new bytes, never a truncated file. */
  fs.renameSync(tmp, file);
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

/* Rebuild missing registry entries from the per-project meta files
 * (BUG-043). Every recordIdentity also writes projects/<id>/project.json,
 * so the meta dir is a durable mirror of everything ever registered.
 * An entry is restored when its meta parses, its id matches its folder,
 * and its root still exists on disk (a dead root would only be pruned
 * again at the next boot). Path-scoped orphans of a folder that also
 * has a remote-scoped entry are skipped, and remote-scoped restores fold
 * their own path dupes, so a restore never resurrects the "two John
 * Simms" split that reconcileAllProjects heals.
 *
 * With `reg` supplied the caller owns saving (the corrupt-file path in
 * loadRegistry); without it the registry is loaded, healed and saved
 * here (the boot call in daemon.ts). Returns the ids added. */
export function restoreFromProjectMeta(reg?: RegistryFile): string[] {
  const own = reg ?? loadRegistry();
  const added: string[] = [];
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(projectsRoot());
  } catch {
    return added;
  }
  const remoteScopedRoots = new Set<string>(
    Object.values(own.projects)
      .filter((e) => e.remote)
      .map((e) => normalizeRoot(e.root)),
  );
  const candidates: ProjectRegistryEntry[] = [];
  for (const id of ids) {
    if (id === 'global' || own.projects[id]) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(projectMetaFile(id), 'utf-8'));
    } catch {
      continue;
    }
    if (!isEntry(parsed) || parsed.id !== id) continue;
    if (!parsed.root || !fs.existsSync(parsed.root)) continue;
    candidates.push(parsed);
    if (parsed.remote) remoteScopedRoots.add(normalizeRoot(parsed.root));
  }
  for (const entry of candidates) {
    if (!entry.remote && remoteScopedRoots.has(normalizeRoot(entry.root))) {
      continue;
    }
    own.projects[entry.id] = entry;
    added.push(entry.id);
  }
  for (const entry of candidates) {
    if (!entry.remote || !own.projects[entry.id]) continue;
    reconcilePathDupes(
      {
        id: entry.id,
        name: entry.name,
        root: entry.root,
        remote: entry.remote,
        scope: 'remote',
      },
      own,
    );
  }
  if (!reg && added.length > 0) saveRegistry(own);
  return added;
}

export function getProject(id: string): ProjectRegistryEntry | undefined {
  return loadRegistry().projects[id];
}
