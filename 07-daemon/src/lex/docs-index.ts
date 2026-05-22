/**
 * Shared docs/INDEX.md reader for the per-turn live_state block (voice)
 * and the worker SessionStart handoff doc.
 *
 * Reads the index file on every call so a doc added between turns
 * lands without a daemon restart. Each section caps at
 * MAX_INDEX_ENTRIES bullets; longer lists truncate with a "+ N more
 * (see file)" footer so the per-turn payload stays bounded.
 *
 * Tier-three of the three-tier memory + docs index (2026-05-22):
 *   - tier 1: per-memory file body (loaded on demand by Lex's Read tool)
 *   - tier 2: MEMORY.md / INDEX.md (table of contents)
 *   - tier 3: this per-turn injection of the table of contents into
 *             every live_state block so the catalog stays in front of
 *             Lex even as context decays over a long session
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = (
  process.env.DEVNEURAL_REPO_ROOT ?? 'C:/dev/Projects/DevNeural'
).replace(/\\/g, '/');
export const DEFAULT_DOCS_INDEX_PATH = path.posix.join(
  REPO_ROOT,
  'docs',
  'INDEX.md',
);
export const MAX_INDEX_ENTRIES = 80;

/* Pull every `- [...]` bullet from a MEMORY.md / INDEX.md file.
 * Tolerates blank lines, headings, and leading paragraphs; we only
 * care about the bullet rows. Returns an empty array on a missing or
 * unreadable file so callers can render a "(none)" placeholder
 * without crashing the snapshot. */
export function loadIndexBullets(file: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- [')) out.push(trimmed);
  }
  return out;
}

export function renderIndexSection(
  header: string,
  bullets: string[],
  sourceLabel: string,
): string[] {
  const lines: string[] = [header];
  if (bullets.length === 0) {
    lines.push('  (none)');
    return lines;
  }
  const capped = bullets.slice(0, MAX_INDEX_ENTRIES);
  for (const b of capped) lines.push(`  ${b}`);
  if (bullets.length > MAX_INDEX_ENTRIES) {
    const more = bullets.length - MAX_INDEX_ENTRIES;
    lines.push(`  + ${more} more (see ${sourceLabel})`);
  }
  return lines;
}
