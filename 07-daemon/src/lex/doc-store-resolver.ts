/**
 * Knowledge-index store-set auto-resolver (Unified Knowledge Index,
 * final piece per docs/HANDOVER.md "Next up").
 *
 * Maps a project cwd to its markdown store roots so /lex/index-docs,
 * /lex/watch-docs, and the /knowledge orb work without the caller
 * hand-passing absolute dirs. Existence-gated: only dirs that exist
 * become stores, so a project without docs/ just gets root + memory.
 *
 * Store set (in emit order):
 *   root    <cwd>            non-recursive (README/TODO/HANDOVER etc.)
 *   memory  ~/.claude/projects/<slug>/memory   non-recursive
 *   docs    <cwd>/docs       recursive
 *   spec    <cwd>/docs/spec  recursive
 *   bugs    <cwd>/docs/bugs  recursive
 *
 * spec/bugs overlap the recursive docs walk on purpose: chunk ids are
 * keyed by path (project-doc:<pid>:<path>#<line>), so the LAST store
 * to index a path wins the label. Emitting spec/bugs after docs makes
 * their more precise labels stick while the docs store still covers
 * every other subdirectory.
 *
 * The shared DATA_ROOT/brainstorm dir is deliberately NOT auto-
 * resolved: it is one directory shared by every brainstorm anchor, so
 * including it would leak cross-project files into a strictly
 * project-scoped index. Callers that want it keep passing it
 * explicitly.
 *
 * Pure + injectable (isDir/homeDir seams) for unit tests.
 */
import * as fs from 'node:fs';
import type { MarkdownStoreSpec } from './markdown-corpus.js';
import { resolveCcProjectDir } from './cc-project-slug.js';

export interface ResolveDocStoresOptions {
  /** Project root (project_session.cwd). */
  cwd: string;
  /** Home dir override (tests). Defaults to HOME / USERPROFILE. */
  homeDir?: string;
  /** Directory-existence seam (tests). Defaults to fs.statSync. */
  isDir?: (p: string) => boolean;
}

function defaultIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/* Case-preserving CC project slug (mirrors Claude Code's on-disk
 * naming: every separator and colon becomes a hyphen, original case
 * kept). rootToSlug in cc-project-slug.ts lowercases for canonical
 * comparison; here we want the literal directory candidate first. */
function casePreservingSlug(cwd: string): string {
  return cwd
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .replace(/[\\/:]/g, '-');
}

export function resolveProjectDocStores(
  opts: ResolveDocStoresOptions,
): MarkdownStoreSpec[] {
  const isDir = opts.isDir ?? defaultIsDir;
  const cwd = opts.cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!cwd || !isDir(cwd)) return [];
  const home = (
    opts.homeDir ??
    process.env.HOME ??
    process.env.USERPROFILE ??
    ''
  ).replace(/\\/g, '/');

  const stores: MarkdownStoreSpec[] = [{ store: 'root', dir: cwd }];

  /* Memory store: exact-case candidate first (cheap, deterministic),
   * then the case-insensitive on-disk scan for cwds whose casing
   * drifted from what CC recorded. The scan only runs with real fs
   * deps (it reads ~/.claude/projects directly). */
  if (home) {
    const candidate = `${home}/.claude/projects/${casePreservingSlug(cwd)}/memory`;
    if (isDir(candidate)) {
      stores.push({ store: 'memory', dir: candidate });
    } else if (!opts.isDir) {
      const resolved = resolveCcProjectDir(cwd);
      if (resolved && isDir(`${resolved}/memory`)) {
        stores.push({ store: 'memory', dir: `${resolved}/memory` });
      }
    }
  }

  const docs = `${cwd}/docs`;
  if (isDir(docs)) stores.push({ store: 'docs', dir: docs, recursive: true });
  const spec = `${cwd}/docs/spec`;
  if (isDir(spec)) stores.push({ store: 'spec', dir: spec, recursive: true });
  const bugs = `${cwd}/docs/bugs`;
  if (isDir(bugs)) stores.push({ store: 'bugs', dir: bugs, recursive: true });

  return stores;
}
