/**
 * Per-anchor git HEAD reader (Fix 34d.2, 2026-05-26).
 *
 * The narrated-success-no-commit detector needs to know whether the
 * branch HEAD advanced since a worker assistant claimed shipment.
 * `git rev-parse HEAD` and `git log -n3` are the canonical sources;
 * both are cheap but shelled out, so a 5 s in-process cache keyed on
 * cwd prevents the per-tick chokidar storm from spawning a child
 * process per worker write.
 *
 * Pure I/O wrapper. Tests inject their own `gitHelpers` via the
 * processChange deps; production paths use these defaults.
 *
 * windowsHide: true on every spawn per the operator's persistent
 * rule so background tail readers do not flash a console window.
 */
import { execFileSync } from 'node:child_process';

export interface RecentCommit {
  sha: string;
  subject: string;
}

export interface GitHelpers {
  getHeadSha(cwd: string): string | null;
  getRecentCommits(cwd: string, n?: number): RecentCommit[];
}

const TTL_MS = 5_000;
const headCache = new Map<string, { sha: string | null; readMs: number }>();
const commitsCache = new Map<
  string,
  { commits: RecentCommit[]; readMs: number }
>();

function run(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

export function getHeadSha(cwd: string): string | null {
  const now = Date.now();
  const cached = headCache.get(cwd);
  if (cached && now - cached.readMs < TTL_MS) return cached.sha;
  const sha = run(cwd, ['rev-parse', 'HEAD']);
  headCache.set(cwd, { sha, readMs: now });
  return sha;
}

export function getRecentCommits(cwd: string, n: number = 3): RecentCommit[] {
  const now = Date.now();
  const key = `${cwd}:${n}`;
  const cached = commitsCache.get(key);
  if (cached && now - cached.readMs < TTL_MS) return cached.commits;
  const out = run(cwd, ['log', `-n${n}`, '--pretty=%h %s']);
  if (out === null) {
    commitsCache.set(key, { commits: [], readMs: now });
    return [];
  }
  const commits: RecentCommit[] = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const idx = line.indexOf(' ');
      if (idx === -1) return { sha: line, subject: '' };
      return { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
    });
  commitsCache.set(key, { commits, readMs: now });
  return commits;
}

export const defaultGitHelpers: GitHelpers = {
  getHeadSha,
  getRecentCommits,
};

export function _resetGitCacheForTests(): void {
  headCache.clear();
  commitsCache.clear();
}
