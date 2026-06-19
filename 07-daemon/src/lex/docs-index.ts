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

/* Relevance ranking (2026-06-19): the index was injected file-order,
 * capped at MAX_INDEX_ENTRIES. On a long-lived brainstorm that meant ~80
 * mostly-irrelevant table-of-contents rows in every prompt while the few
 * bullets bearing on the live turn could be below the cap. renderIndexSection
 * now accepts a `query` (the current utterance); when present it scores each
 * bullet by lexical overlap with the query, always keeps a small pinned
 * safety/identity core, and injects only the top `limit`. Nothing is lost:
 * the "+ N more (see file)" footer plus Lex's Read tool make the full list
 * one read away. No query => legacy file-order behaviour, unchanged. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'it',
  'that', 'this', 'with', 'as', 'at', 'by', 'be', 'are', 'was', 'you', 'your',
  'my', 'we', 'not', 'no', 'so', 'do', 'does', 'did', 'if', 'how', 'what',
  'why', 'when', 'then', 'than', 'from', 'into', 'out', 'up', 'about', 'just',
  'can', 'will', 'should', 'would', 'need', 'needs', 'want', 'get', 'got',
  'fucking', 'fuck', 'shit', 'like', 'mode', 'voice',
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Count of distinct query tokens present in the bullet text. Pure +
 * synchronous so it stays on the per-turn inject hot path with no
 * latency cost; semantic (embedding) scoring can layer on later. */
export function scoreBulletAgainstQuery(
  bullet: string,
  queryTokens: Set<string>,
): number {
  if (queryTokens.size === 0) return 0;
  const bt = new Set(tokenize(bullet));
  let score = 0;
  for (const q of queryTokens) if (bt.has(q)) score += 1;
  return score;
}

export interface IndexRenderOpts {
  /** Current utterance / active-thread text. When set, bullets are
   * ranked by lexical overlap with it instead of file order. */
  query?: string | null;
  /** Max bullets to inject. Defaults to MAX_INDEX_ENTRIES. */
  limit?: number;
  /** Predicate for bullets that must always survive ranking (safety +
   * identity memories). Pinned bullets are kept even past `limit`. */
  isPinned?: (bullet: string) => boolean;
}

function selectRelevant(
  bullets: string[],
  query: string,
  limit: number,
  isPinned?: (bullet: string) => boolean,
): string[] {
  const qTokens = new Set(tokenize(query));
  const scored = bullets.map((b, i) => ({
    b,
    i,
    pinned: isPinned ? isPinned(b) : false,
    score: scoreBulletAgainstQuery(b, qTokens),
  }));
  const pinned = scored.filter((s) => s.pinned).sort((a, z) => a.i - z.i);
  const rest = scored
    .filter((s) => !s.pinned)
    .sort((a, z) => z.score - a.score || a.i - z.i);
  const chosenRest: typeof rest = [];
  for (const s of rest) {
    if (pinned.length + chosenRest.length >= limit) break;
    chosenRest.push(s);
  }
  return [...pinned.map((s) => s.b), ...chosenRest.map((s) => s.b)];
}

export function renderIndexSection(
  header: string,
  bullets: string[],
  sourceLabel: string,
  opts: IndexRenderOpts = {},
): string[] {
  const lines: string[] = [header];
  if (bullets.length === 0) {
    lines.push('  (none)');
    return lines;
  }
  const limit = opts.limit ?? MAX_INDEX_ENTRIES;
  const chosen =
    opts.query && opts.query.trim()
      ? selectRelevant(bullets, opts.query, limit, opts.isPinned)
      : bullets.slice(0, limit);
  for (const b of chosen) lines.push(`  ${b}`);
  if (bullets.length > chosen.length) {
    const more = bullets.length - chosen.length;
    lines.push(`  + ${more} more (see ${sourceLabel})`);
  }
  return lines;
}
