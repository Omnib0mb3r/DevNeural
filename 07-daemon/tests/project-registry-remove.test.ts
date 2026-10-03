/**
 * Remove from dashboard (2026-10-03). The operator can take a project
 * off the dashboard from the Add existing picker. The folder stays on
 * disk. The removal has to stick: the fs watcher, the transcript watcher
 * and the session hook all call recordIdentity on activity, and the boot
 * restore rebuilds entries from per-project meta, so each of those must
 * skip a removed folder. Only an explicit add brings it back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let priorDataRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-regrm-')).replace(/\\/g, '/');
  priorDataRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  if (priorDataRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorDataRoot;
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function identity(name: string) {
  const root = path.posix.join(tmpDir, 'tree', name);
  fs.mkdirSync(root, { recursive: true });
  return { id: `a1b2c3${name.padEnd(6, '0').slice(0, 6)}`, name, root, remote: null, scope: 'path' as const };
}

describe('removeProject', () => {
  it('takes the project off, and automatic registration does not bring it back', async () => {
    const reg = await import('../src/identity/registry.js');
    const id = identity('scratch');
    reg.recordIdentity(id);
    expect(reg.getProject(id.id)).toBeDefined();

    expect(reg.removeProject(id.id)).toBe(true);
    expect(reg.getProject(id.id)).toBeUndefined();
    expect(fs.existsSync(id.root)).toBe(true);

    reg.recordIdentity(id);
    expect(reg.getProject(id.id)).toBeUndefined();
    expect(reg.restoreFromProjectMeta()).toEqual([]);
    expect(reg.getProject(id.id)).toBeUndefined();
  });

  it('an explicit add brings it back and clears the removal', async () => {
    const reg = await import('../src/identity/registry.js');
    const id = identity('again');
    reg.recordIdentity(id);
    reg.removeProject(id.id);
    reg.recordIdentity(id, { explicit: true });
    expect(reg.getProject(id.id)).toBeDefined();
    reg.removeProject(id.id);
    reg.recordIdentity(id, { explicit: true });
    reg.recordIdentity(id);
    expect(reg.getProject(id.id)).toBeDefined();
  });

  it('adding back keeps the original first_seen', async () => {
    const reg = await import('../src/identity/registry.js');
    const id = identity('history');
    reg.recordIdentity(id);
    const first = reg.getProject(id.id)!.first_seen;
    await new Promise((r) => setTimeout(r, 15));
    reg.removeProject(id.id);
    reg.recordIdentity(id, { explicit: true });
    expect(reg.getProject(id.id)!.first_seen).toBe(first);
  });

  it('returns false for an unknown id', async () => {
    const reg = await import('../src/identity/registry.js');
    expect(reg.removeProject('ffffffffffff')).toBe(false);
  });
});
