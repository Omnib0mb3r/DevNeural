/**
 * Wave 2 day 5 step 20 (LX-1 / B1). Disk-backed archive of every
 * Lex system-prompt revision. archivePromptVersion writes
 * <data>/lex-prompts/<version>.md whenever the assembled prompt
 * differs from any version already on disk (content-addressed
 * dedupe via the short hash in the filename).
 *
 * Version format: `<iso-with-colons-as-dashes>__<sha256-first-7>`
 * The hash is the first 7 hex chars of sha256(prompt body); the
 * timestamp prefix keeps filenames monotonic so two writes inside
 * the same millisecond cannot collide. Legacy 8-char hashes from
 * earlier sha1-based archives are tolerated by the version regex
 * so a flag-day swap does not double-write the historical set.
 *
 * Atomic write: every fresh version writes to <version>.md.partial
 * first, then fs.renameSync into place so a torn write cannot
 * surface a half-written prompt to a reader.
 *
 * Backfill: backfillPromptVersions is intended to be called once
 * at daemon boot with an assembler thunk that returns the stable
 * (snapshot-free) body for each canonical mode. On a fresh
 * checkout the archive starts empty; the backfill primes it with
 * one entry per mode so the step 21 A/B replay harness has at
 * least one row to compare against. On an existing install where
 * those bodies are already archived, every call is a hash-dedup
 * no-op.
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

/* `<ts>__<hash>` with hash either 7 (current sha256) or 8 (legacy
 * sha1) hex chars. Non-archive files in the same directory
 * (refusal-contract.md, few-shot/*) must NOT match so they are
 * excluded from the version list and the dedupe scan. */
const VERSION_FILENAME_PATTERN = /^(.+?)__([0-9a-f]{7,8})$/;

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 7);
}

function listVersionsSorted(): ArchivedPromptVersion[] {
  const dir = lexPromptVersionsDir();
  if (!fs.existsSync(dir)) return [];
  const entries: ArchivedPromptVersion[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const version = name.replace(/\.md$/, '');
    const m = version.match(VERSION_FILENAME_PATTERN);
    if (!m) continue;
    const filePath = path.posix.join(dir, name);
    try {
      if (!fs.statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    entries.push({ version, filePath, hash: m[2] ?? '' });
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
  /* Content-addressed dedupe: any existing entry with this hash
   * means the body is already on disk. This catches the
   * mode-switch case where prompt assembly alternates between
   * `conversation` and `notes` — same hashed body must produce
   * one archive entry, not one per assembly. */
  const existing = all.find((e) => e.hash === hash);
  if (existing) return existing;
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

export type PromptArchiveMode = 'conversation' | 'push-to-talk' | 'notes';

export interface BackfillResult {
  written: number;
  skipped: number;
  modes: PromptArchiveMode[];
}

/**
 * One-shot backfill called from the daemon bootstrap. The
 * assembler returns the stable (snapshot-free) prompt body for a
 * given mode; the live snapshot section is excluded because its
 * timestamp + counters drift every call and would force a new
 * archive entry on every boot. On an empty archive directory this
 * writes one file per mode; on an already-primed install every
 * call dedupes against the existing hash set. Errors are returned
 * via the `errors` field rather than thrown so the caller does not
 * block daemon boot on a stat or fs failure.
 */
export function backfillPromptVersions(
  assembleStable: (mode: PromptArchiveMode) => string,
  modes: readonly PromptArchiveMode[] = ['conversation', 'push-to-talk', 'notes'],
): BackfillResult & { errors: string[] } {
  ensureDir(lexPromptVersionsDir());
  const errors: string[] = [];
  let written = 0;
  let skipped = 0;
  for (const mode of modes) {
    try {
      const body = assembleStable(mode);
      const before = listVersionsSorted().length;
      archivePromptVersion(body);
      const after = listVersionsSorted().length;
      if (after > before) written += 1;
      else skipped += 1;
    } catch (err) {
      errors.push(`${mode}: ${(err as Error).message}`);
    }
  }
  return { written, skipped, modes: [...modes], errors };
}
