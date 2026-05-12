/**
 * Wave 2 day 5 step 20 (LX-1). Disk-backed prompt archive: writes
 * one row per change, dedupes identical bodies, exposes monotonic
 * version ids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let priorRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs
    .mkdtempSync(path.join(os.tmpdir(), 'devneural-lp-'))
    .replace(/\\/g, '/');
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('archivePromptVersion', () => {
  it('writes a fresh version when prompt body changes', async () => {
    const { archivePromptVersion, listPromptVersions } = await import(
      '../src/lex/prompt-archive.js'
    );
    const v1 = archivePromptVersion('hello prompt');
    const v2 = archivePromptVersion('hello prompt v2');
    expect(v1.version).not.toBe(v2.version);
    const all = listPromptVersions().map((v) => v.version);
    expect(all).toContain(v1.version);
    expect(all).toContain(v2.version);
  });

  it('does not duplicate when prompt body is unchanged', async () => {
    const { archivePromptVersion, listPromptVersions } = await import(
      '../src/lex/prompt-archive.js'
    );
    const v1 = archivePromptVersion('stable prompt');
    const v2 = archivePromptVersion('stable prompt');
    expect(v1.version).toBe(v2.version);
    expect(listPromptVersions()).toHaveLength(1);
  });

  it('readPromptVersion returns body for a known version + null otherwise', async () => {
    const { archivePromptVersion, readPromptVersion } = await import(
      '../src/lex/prompt-archive.js'
    );
    const v = archivePromptVersion('readable body');
    expect(readPromptVersion(v.version)).toBe('readable body');
    expect(readPromptVersion('does-not-exist')).toBeNull();
  });

  it('monotonic-version-ordering: filenames sort in write order', async () => {
    const { archivePromptVersion, listPromptVersions } = await import(
      '../src/lex/prompt-archive.js'
    );
    const v1 = archivePromptVersion('one');
    await new Promise((r) => setTimeout(r, 5));
    const v2 = archivePromptVersion('two');
    await new Promise((r) => setTimeout(r, 5));
    const v3 = archivePromptVersion('three');
    const ordered = listPromptVersions().map((v) => v.version);
    expect(ordered).toEqual([v1.version, v2.version, v3.version]);
  });

  it('backfill-on-empty-archive: first write lands a single file', async () => {
    const { archivePromptVersion, listPromptVersions } = await import(
      '../src/lex/prompt-archive.js'
    );
    expect(listPromptVersions()).toEqual([]);
    const v = archivePromptVersion('cold-boot body');
    const all = listPromptVersions();
    expect(all).toHaveLength(1);
    expect(all[0]!.version).toBe(v.version);
    expect(all[0]!.hash).toMatch(/^[0-9a-f]{7}$/);
  });

  it('idempotent-on-unchanged-prompt: no new file written on identical body', async () => {
    const { archivePromptVersion, listPromptVersions } = await import(
      '../src/lex/prompt-archive.js'
    );
    archivePromptVersion('stable body');
    await new Promise((r) => setTimeout(r, 5));
    archivePromptVersion('stable body');
    await new Promise((r) => setTimeout(r, 5));
    archivePromptVersion('stable body');
    expect(listPromptVersions()).toHaveLength(1);
  });

  it('hash-collision-on-different-content: different bodies get distinct hashes', async () => {
    const { archivePromptVersion } = await import(
      '../src/lex/prompt-archive.js'
    );
    const a = archivePromptVersion('alpha body');
    const b = archivePromptVersion('beta body');
    expect(a.hash).not.toBe(b.hash);
    expect(a.version).not.toBe(b.version);
    expect(a.hash).toMatch(/^[0-9a-f]{7}$/);
    expect(b.hash).toMatch(/^[0-9a-f]{7}$/);
  });

  it('atomic-write: no .partial residue after a successful archive', async () => {
    const { archivePromptVersion } = await import(
      '../src/lex/prompt-archive.js'
    );
    const v = archivePromptVersion('atomic body');
    const dir = path.posix.dirname(v.filePath);
    const residue = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.partial'));
    expect(residue).toEqual([]);
  });
});
