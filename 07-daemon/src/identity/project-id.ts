import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { ProjectIdentity } from '../types.js';

export function normalizeRemote(remote: string): string {
  return remote
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

export function hashId(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function tryGitRemote(cwd: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return remote || null;
  } catch {
    return null;
  }
}

function tryGitToplevel(cwd: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
      .trim()
      .replace(/\\/g, '/');
  } catch {
    return null;
  }
}

export function resolveProjectIdentity(cwd: string): ProjectIdentity {
  if (!cwd || !fs.existsSync(cwd)) {
    return { id: 'global', name: 'global', root: cwd ?? '', remote: null, scope: 'global' };
  }

  const remote = tryGitRemote(cwd);
  if (remote) {
    const normalized = normalizeRemote(remote);
    const id = hashId(normalized);
    const toplevel = tryGitToplevel(cwd) ?? cwd;
    const name = path.basename(toplevel);
    return { id, name, root: toplevel, remote: normalized, scope: 'remote' };
  }

  const toplevel = tryGitToplevel(cwd);
  if (toplevel) {
    const id = hashId(toplevel.toLowerCase());
    const name = path.basename(toplevel);
    return { id, name, root: toplevel, remote: null, scope: 'path' };
  }

  return { id: 'global', name: 'global', root: cwd, remote: null, scope: 'global' };
}

/* Root comparison/hash key: forward slashes, no trailing slash. Matches
 * the shape tryGitToplevel already returns, so a path hashed here and a
 * path hashed off git's toplevel land on the same id. */
export function normalizeFsRoot(p: string): string {
  return (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/* Explicit-registration identity (2026-08-26, BUG-021).
 *
 * resolveProjectIdentity returns `global` for any folder git cannot
 * claim: no remote AND no `git rev-parse --show-toplevel`. That is
 * correct on the CAPTURE path (a session opened in C:/Users/michael
 * must not mint a project), but wrong when the operator has
 * deliberately pointed the dashboard at a folder. Every non-git folder
 * under C:/dev/Projects (netlify-deploy, transcribe,
 * godaddy-cpanel-deploy, ...) hit `global` and so 422'd out of
 * POST /projects/register-path and was silently dropped as
 * `no_identity` by scan-and-register.
 *
 * This wrapper leaves the default resolver (and therefore all eight
 * capture-side callers) untouched, and adds a filesystem-path fallback
 * for the two operator-initiated routes only: hash the normalized
 * absolute path, scope 'path', remote null.
 *
 * Id continuity: the hash input is normalized exactly the way branch 2
 * normalizes git's toplevel (forward slashes, no trailing slash,
 * lowercased), so a folder later given `git init` with no remote
 * resolves through the normal path branch to the SAME id, no dupe. If
 * it later gains a remote its id changes by design, and recordIdentity's
 * reconcilePathDupes folds the path-scoped entry into the remote-scoped
 * one (registry.ts). */
export function resolveProjectIdentityForRegistration(
  dir: string,
): ProjectIdentity {
  const base = resolveProjectIdentity(dir);
  if (base.id !== 'global') return base;

  const root = normalizeFsRoot(dir);
  if (!root || !fs.existsSync(root)) {
    return { id: 'global', name: 'global', root, remote: null, scope: 'global' };
  }
  return {
    id: hashId(root.toLowerCase()),
    name: path.basename(root),
    root,
    remote: null,
    scope: 'path',
  };
}
