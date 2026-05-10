/**
 * Wave 2 day 5 step 20 (LX-1 / B1). Disk-backed archive of every
 * Lex system-prompt revision. archivePromptVersion writes
 * <data>/lex-prompts/<version>.md whenever the assembled prompt
 * differs from the most recent archived copy. Version is a
 * monotonic ISO timestamp + 8-char sha1 of the prompt body so two
 * different prompts produced inside the same millisecond do not
 * collide.
 *
 * Existing prompts get a backfill row on first run via
 * archivePromptVersion(); subsequent boots skip the write when the
 * latest archive content already matches.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ensureDir,
  lexPromptVersionsDir,
} from '../paths.js';

export interface ArchivedPromptVersion {
  version: string;
  /* ISO timestamp + short hash, monotonic for two-prompts-same-ms ties. */
  filePath: string;
  hash: string;
}

function sha8(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

function listVersionsSorted(): ArchivedPromptVersion[] {
  const dir = lexPromptVersionsDir();
  if (!fs.existsSync(dir)) return [];
  const entries: ArchivedPromptVersion[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const filePath = path.posix.join(dir, name);
    if (!fs.statSync(filePath).isFile()) continue;
    const version = name.replace(/\.md$/, '');
    /* Format: <iso>__<hash>.md. Pull the hash out for fast equality
     * checks without re-reading the file body. Older archives that
     * pre-date the format are tolerated (hash defaults to ''). */
    const m = version.match(/^(.+?)__([0-9a-f]{8})$/);
    entries.push({
      version,
      filePath,
      hash: m?.[2] ?? '',
    });
  }
  entries.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  return entries;
}

export function listPromptVersions(): ArchivedPromptVersion[] {
  return listVersionsSorted();
}

export function readPromptVersion(version: string): string | null {
  const dir = lexPromptVersionsDir();
  const safe = version.replace(/[^a-zA-Z0-9_:.\-]/g, '');
  const filePath = path.posix.join(dir, `${safe}.md`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export function archivePromptVersion(prompt: string): ArchivedPromptVersion {
  ensureDir(lexPromptVersionsDir());
  const hash = sha8(prompt);
  const all = listVersionsSorted();
  const latest = all[all.length - 1];
  if (latest && latest.hash === hash) {
    return latest;
  }
  /* Normalise the ISO timestamp into a filename-safe form: replace
   * the `:` characters that Windows file systems reject. */
  const ts = new Date().toISOString().replace(/[:]/g, '-');
  const version = `${ts}__${hash}`;
  const filePath = path.posix.join(lexPromptVersionsDir(), `${version}.md`);
  fs.writeFileSync(filePath, prompt, 'utf-8');
  return { version, filePath, hash };
}
