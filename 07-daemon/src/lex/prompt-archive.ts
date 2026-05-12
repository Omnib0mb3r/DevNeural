/**
 * Wave 2 day 5 step 20 (LX-1 / B1). Disk-backed archive of every
 * Lex system-prompt revision. archivePromptVersion writes
 * <data>/lex-prompts/<version>.md whenever the assembled prompt
 * differs from the most recent archived copy.
 *
 * Version format: `<iso-with-colons-as-dashes>__<sha256-first-7>`
 * The hash is the first 7 hex chars of sha256(prompt body); the
 * timestamp prefix keeps the filename monotonic so two writes
 * inside the same millisecond cannot collide on the same filename.
 *
 * Existing prompts get a backfill row on first run via
 * archivePromptVersion(); subsequent boots skip the write when the
 * latest archive content already matches.
 *
 * Atomic write: every fresh version writes to <version>.md.partial
 * first, then fs.renameSync into place so a torn write cannot
 * surface a half-written prompt to a reader.
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

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 7);
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
    /* Format: <iso>__<hash>.md. The hash is the first 7 hex chars
     * of sha256(body). Older archives written with an 8-char sha1
     * are still tolerated (the regex matches either width); their
     * hash field is exposed verbatim so a same-content check still
     * compares against whatever the legacy format produced and we
     * do not double-write on first boot after the format swap. */
    const m = version.match(/^(.+?)__([0-9a-f]{7,8})$/);
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
  const hash = shortHash(prompt);
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
  /* Atomic write: render to <file>.partial then rename. A torn
   * write (process death mid-fsync) leaves a .partial sibling that
   * listVersionsSorted ignores (only *.md is matched). */
  const partial = `${filePath}.partial`;
  fs.writeFileSync(partial, prompt, 'utf-8');
  fs.renameSync(partial, filePath);
  return { version, filePath, hash };
}
