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
});
