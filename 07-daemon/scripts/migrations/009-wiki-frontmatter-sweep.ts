/**
 * WI-1, WI-2, WI-3, WI-4: Wiki frontmatter sweep.
 *
 * Walks every wiki page on disk and adds the new Phase Two
 * frontmatter defaults if absent:
 *
 *   schema_version: 2
 *   last_verified: null
 *   frozen: false
 *   source_brainstorms: []
 *   source_meetings: []
 *   derived_from_brainstorm: false
 *   derived_from_meeting: false
 *
 * Idempotent: running twice does not duplicate or modify pages that
 * already have the field. Verified-on-day-1 (Q-8) confirms the wiki
 * frontmatter parser tolerates unknown fields, so adding these is
 * non-breaking for older daemon code.
 *
 * No DB writes other than the runner's own `_migrations` row;
 * the (db) parameter is accepted to satisfy the runner contract but
 * unused by this migration. File I/O happens directly on disk.
 */
import type Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

function dataRoot(): string {
  return (
    process.env.DEVNEURAL_DATA_ROOT?.replace(/\\/g, '/') ??
    'C:/dev/data/skill-connections'
  );
}

function wikiRoot(): string {
  return path.posix.join(dataRoot(), 'wiki');
}

const DEFAULTS: Array<[string, string]> = [
  ['schema_version', '2'],
  ['last_verified', 'null'],
  ['frozen', 'false'],
  ['source_brainstorms', '[]'],
  ['source_meetings', '[]'],
  ['derived_from_brainstorm', 'false'],
  ['derived_from_meeting', 'false'],
];

function listMarkdownPages(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMarkdownPages(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function ensureFrontmatter(content: string): { content: string; changed: boolean } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = content.match(fm);
  if (!match) {
    const block =
      '---\n' +
      DEFAULTS.map(([k, v]) => `${k}: ${v}`).join('\n') +
      '\n---\n\n';
    return { content: block + content, changed: true };
  }
  const head = match[1];
  const headLines = head.split(/\r?\n/);
  const existingKeys = new Set(
    headLines
      .map((l) => l.match(/^([A-Za-z0-9_]+)\s*:/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1]),
  );
  const additions = DEFAULTS.filter(([k]) => !existingKeys.has(k)).map(
    ([k, v]) => `${k}: ${v}`,
  );
  if (additions.length === 0) return { content, changed: false };
  const newHead = head + '\n' + additions.join('\n');
  const replacement = `---\n${newHead}\n---\n`;
  const trailingNewline = match[0].endsWith('\n') ? '' : '\n';
  return {
    content: content.replace(fm, replacement + trailingNewline),
    changed: true,
  };
}

export default function migrate(_db: Database.Database): void {
  const root = wikiRoot();
  if (!fs.existsSync(root)) {
    process.stderr.write(
      `[009-wiki-frontmatter-sweep] WIKI_ROOT not found: ${root}; skipping\n`,
    );
    return;
  }
  const pages = listMarkdownPages(root);
  let updated = 0;
  for (const file of pages) {
    const before = fs.readFileSync(file, 'utf8');
    const { content, changed } = ensureFrontmatter(before);
    if (changed) {
      fs.writeFileSync(file, content, 'utf8');
      updated += 1;
    }
  }
  process.stderr.write(
    `[009-wiki-frontmatter-sweep] scanned=${pages.length} updated=${updated}\n`,
  );
}
