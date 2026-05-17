/**
 * Claude Code project-slug canonicalization + on-disk directory
 * resolution.
 *
 * CC stores per-workspace transcripts under
 * `~/.claude/projects/<slug>/<session>.jsonl`. The slug is derived
 * from the workspace cwd by flattening every separator and colon into
 * a hyphen. CC preserves the original case from the cwd it sees at
 * spawn time, so a workspace launched from `C:\dev\Projects\DevNeural`
 * lands at `C--dev-Projects-DevNeural` on disk; one launched from
 * `c:/dev/projects/devneural` would land at `c--dev-projects-devneural`.
 *
 * The daemon's anchor rows do not necessarily carry the exact same
 * casing CC saw at spawn time. Project-anchor backfill, bridge
 * presence files, and external import paths each apply their own
 * casing rules; the auto-advance supervisor's previous hand-rolled
 * resolver dropped the drive letter, lowercased the whole path, and
 * prefixed `c-`, which mismatched whatever CC actually wrote on disk
 * and surfaced as endless `decision=skip reason=no-jsonl` ticks.
 *
 * rootToSlug here is the shared canonical encoder used elsewhere in
 * the daemon (see the inline copy in dashboard/routes.ts that this
 * module supersedes). It produces a fully-lowercased canonical key.
 * resolveCcProjectDir uses that key to scan `~/.claude/projects/` and
 * pick the matching directory case-insensitively, returning the
 * directory name as it appears on disk so subsequent path joins land
 * on a real file.
 *
 * Centralised so every caller (auto-advance supervisor, brainstorm
 * jsonl ingestor, dashboard active-projects diff) uses the same
 * encoding + resolution. A future CC change to slug formatting
 * (e.g. URL-encoding of unicode) only needs to land here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/* Canonical slug for a cwd. Steps:
 *   1. Backslashes -> forward slashes so Windows paths normalise
 *      against the same shape as POSIX entries.
 *   2. Collapse runs of slashes (`/a//b` -> `/a/b`) so a stray
 *      trailing separator or doubled join cannot fork the key.
 *   3. Lowercase so case differences in the drive letter or path
 *      segments do not produce two slugs that should be one.
 *   4. Strip a trailing slash so `/a/` and `/a` collapse.
 *   5. Replace every backslash / forward slash / colon with a
 *      hyphen to match Claude Code's on-disk directory naming. */
export function rootToSlug(root: string): string {
  return root
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase()
    .replace(/\/$/, '')
    .replace(/[\\/:]/g, '-');
}

export function ccProjectsRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (!home) return '';
  return path.posix.join(home.replace(/\\/g, '/'), '.claude', 'projects');
}

/* Walk ~/.claude/projects and return the directory whose name's
 * lowercased form equals the canonical slug for the given cwd.
 * Returns the absolute path with the on-disk casing preserved so
 * subsequent `path.join` calls hit a real file. Returns null when
 * no directory matches. */
export function resolveCcProjectDir(cwd: string): string | null {
  const root = ccProjectsRoot();
  if (!root || !fs.existsSync(root)) return null;
  const want = rootToSlug(cwd);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.toLowerCase() === want) {
      return path.posix.join(root, e.name);
    }
  }
  return null;
}

/* Resolve the absolute CC jsonl path for an anchor's cwd + the
 * currently-bound session id. Returns null when no project
 * directory matches. */
export function resolveCcJsonlPath(
  cwd: string,
  sessionId: string,
): string | null {
  if (!sessionId) return null;
  const dir = resolveCcProjectDir(cwd);
  if (!dir) return null;
  return path.posix.join(dir, `${sessionId}.jsonl`);
}
