/* Prompt archive (step 20 / LX-1). Pins the contracts:
 *   1. Identical body produces exactly one archive file.
 *   2. Different bodies produce one file each.
 *   3. Non-archive files in the same directory (refusal-contract.md,
 *      few-shot subdir) do not break the dedupe lookup and do not
 *      get returned by listPromptVersions.
 *   4. backfillPromptVersions writes one file per mode on an empty
 *      directory and skips all writes when the bodies are already
 *      archived.
 *
 * Each test runs against a fresh tmpdir DEVNEURAL_DATA_ROOT so the
 * real archive (which has 200 historical entries) is never touched.
 * paths.ts captures DATA_ROOT at module load, so we vi.resetModules
 * between tests and dynamic-import the archive module against the
 * fresh env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpRoot: string;
const origDataRoot = process.env.DEVNEURAL_DATA_ROOT;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-prompt-archive-'));
  process.env.DEVNEURAL_DATA_ROOT = tmpRoot;
  vi.resetModules();
});

afterEach(() => {
  if (origDataRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = origDataRoot;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function archiveDir(): string {
  return path.posix.join(tmpRoot.replace(/\\/g, '/'), 'lex-prompts');
}

async function loadModule() {
  return await import('../src/lex/prompt-archive.js');
}

describe('archivePromptVersion', () => {
  it('writes one file per unique body and dedupes identical bodies', async () => {
    const { archivePromptVersion, listPromptVersions } = await loadModule();
    const body = '# IDENTITY\n\nyou are lex.\n';
    const first = archivePromptVersion(body);
    const second = archivePromptVersion(body);
    /* Same body, second call returns the same entry without
     * touching the filesystem. */
    expect(second).toEqual(first);
    expect(listPromptVersions().length).toBe(1);
    /* File on disk matches the body verbatim. */
    expect(fs.readFileSync(first.filePath, 'utf-8')).toBe(body);
  });

  it('writes a new entry when the body changes', async () => {
    const { archivePromptVersion, listPromptVersions } = await loadModule();
    const a = archivePromptVersion('alpha\n');
    const b = archivePromptVersion('beta\n');
    expect(a.hash).not.toBe(b.hash);
    expect(listPromptVersions().length).toBe(2);
    /* Both files reachable by readPromptVersion. */
    const { readPromptVersion } = await loadModule();
    expect(readPromptVersion(a.version)).toBe('alpha\n');
    expect(readPromptVersion(b.version)).toBe('beta\n');
  });

  it('ignores non-archive files in the same directory', async () => {
    const { archivePromptVersion, listPromptVersions } = await loadModule();
    fs.mkdirSync(archiveDir(), { recursive: true });
    /* Sibling files the prompt-blocks loader drops into the same
     * dir. These must NOT show up in listPromptVersions and must
     * NOT participate in dedupe (sorted-last + empty hash would
     * silently break the dedupe check on the latest entry). */
    fs.writeFileSync(path.posix.join(archiveDir(), 'refusal-contract.md'), 'refuse\n');
    fs.writeFileSync(
      path.posix.join(archiveDir(), 'refusal-contract-meeting.md'),
      'refuse meeting\n',
    );
    fs.mkdirSync(path.posix.join(archiveDir(), 'few-shot'), { recursive: true });
    fs.writeFileSync(
      path.posix.join(archiveDir(), 'few-shot', 'conversation.md'),
      'few-shot\n',
    );
    const a = archivePromptVersion('payload\n');
    const list = listPromptVersions();
    expect(list.length).toBe(1);
    expect(list[0]!.version).toBe(a.version);
    /* Second archive of the same body still dedupes even though
     * the sibling files exist. */
    archivePromptVersion('payload\n');
    expect(listPromptVersions().length).toBe(1);
  });

  it('dedupes by content hash across the full archive, not just the latest entry', async () => {
    const { archivePromptVersion, listPromptVersions } = await loadModule();
    /* Sequence A, B, A — the third call must dedupe against the
     * first even though B is the most recent. The previous
     * implementation only checked the latest entry and would have
     * written a third A file. */
    archivePromptVersion('A\n');
    archivePromptVersion('B\n');
    const aAgain = archivePromptVersion('A\n');
    const list = listPromptVersions();
    expect(list.length).toBe(2);
    /* aAgain.version points at the original A entry, not a new one. */
    expect(list.some((e) => e.version === aAgain.version)).toBe(true);
  });
});

describe('backfillPromptVersions', () => {
  it('writes one file per mode on an empty archive', async () => {
    const { backfillPromptVersions, listPromptVersions } = await loadModule();
    const r = backfillPromptVersions((mode) => `body for ${mode}\n`);
    expect(r.written).toBe(3);
    expect(r.skipped).toBe(0);
    expect(r.errors).toEqual([]);
    expect(listPromptVersions().length).toBe(3);
  });

  it('is idempotent: a second call writes nothing', async () => {
    const { backfillPromptVersions, listPromptVersions } = await loadModule();
    backfillPromptVersions((mode) => `body for ${mode}\n`);
    const before = listPromptVersions().length;
    const r = backfillPromptVersions((mode) => `body for ${mode}\n`);
    expect(r.written).toBe(0);
    expect(r.skipped).toBe(3);
    expect(listPromptVersions().length).toBe(before);
  });

  it('catches assembler errors per-mode without aborting the run', async () => {
    const { backfillPromptVersions, listPromptVersions } = await loadModule();
    const r = backfillPromptVersions((mode) => {
      if (mode === 'notes') throw new Error('blow up');
      return `body for ${mode}\n`;
    });
    expect(r.written).toBe(2);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toMatch(/notes: blow up/);
    expect(listPromptVersions().length).toBe(2);
  });

  it('collapses modes that produce identical bodies into one file', async () => {
    const { backfillPromptVersions, listPromptVersions } = await loadModule();
    const r = backfillPromptVersions(() => 'same body\n');
    expect(r.written).toBe(1);
    expect(r.skipped).toBe(2);
    expect(listPromptVersions().length).toBe(1);
  });
});
