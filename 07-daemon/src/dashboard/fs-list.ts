/**
 * Folder listing for the "Add existing project" picker (2026-07-23),
 * with each folder marked when it is already a registered project
 * (2026-10-03), so the operator can see at a glance which folders in
 * C:/dev/Projects are new and still need adding.
 *
 * "Registered" means a project-registry entry whose root is this
 * folder: the same registry the Projects grid renders.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FsDirEntry {
  name: string;
  path: string;
  has_git: boolean;
  registered: boolean;
}

/** Registry roots and folder paths compare on this form: forward
 * slashes, no trailing slash, lowercase (Windows paths are
 * case-insensitive and the registry stores them lowercased). */
export function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function listDirsWithRegistration(
  target: string,
  registeredRoots: Iterable<string>,
): FsDirEntry[] {
  const roots = new Set<string>();
  for (const r of registeredRoots) if (r) roots.add(normalizeForCompare(r));
  return fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const full = path.posix.join(target, e.name);
      return {
        name: e.name,
        path: full,
        has_git: fs.existsSync(path.posix.join(full, '.git')),
        registered: roots.has(normalizeForCompare(full)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
