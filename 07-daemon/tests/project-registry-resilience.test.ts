/**
 * BUG-043 (2026-09-24): the project registry kept collapsing to one or
 * two entries. Two processes wrote projects.json with truncate-then-write
 * saves, a reader in the other side's truncate window saw an empty file,
 * loadRegistry silently answered "no projects", and the next save wrote
 * a registry holding only the caller's project.
 *
 * Pins: saves are atomic (no temp files, always valid JSON); an
 * unreadable registry is quarantined and rebuilt from the per-project
 * meta files instead of starting empty; the boot restore adds missing
 * entries with live roots and never resurrects a path dupe of a
 * remote-scoped folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let priorDataRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs
    .mkdtempSync(path.join(os.tmpdir(), 'devneural-registry-'))
    .replace(/\\/g, '/');
  priorDataRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  if (priorDataRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorDataRoot;
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkRoot(name: string): string {
  const root = path.posix.join(tmpDir, 'tree', name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

const A_ID = 'aaaaaaaaaaaa';
const B_ID = 'bbbbbbbbbbbb';
const C_ID = 'cccccccccccc';

describe('project registry resilience (BUG-043)', () => {
  it('saves atomically: valid JSON on disk and no temp files left behind', async () => {
    const reg = await import('../src/identity/registry.js');
    const root = mkRoot('alpha');
    reg.recordIdentity({ id: A_ID, name: 'alpha', root, remote: null, scope: 'path' });
    const file = path.posix.join(tmpDir, 'projects.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      projects: Record<string, { name: string }>;
    };
    expect(parsed.projects[A_ID]?.name).toBe('alpha');
    expect(
      fs.readdirSync(tmpDir).filter((f) => f.startsWith('projects.json.tmp')),
    ).toEqual([]);
  });

  it('rebuilds an unreadable registry from per-project meta instead of starting empty', async () => {
    const reg = await import('../src/identity/registry.js');
    const rootA = mkRoot('alpha');
    const rootB = mkRoot('beta');
    reg.recordIdentity({ id: A_ID, name: 'alpha', root: rootA, remote: null, scope: 'path' });
    reg.recordIdentity({
      id: B_ID,
      name: 'beta',
      root: rootB,
      remote: 'https://example.invalid/beta',
      scope: 'remote',
    });
    const file = path.posix.join(tmpDir, 'projects.json');
    /* The torn read: an empty file mid-write from the other process. */
    fs.writeFileSync(file, '', 'utf-8');

    const ids = reg.listProjects().map((p) => p.id).sort();
    expect(ids).toEqual([A_ID, B_ID]);
    expect(
      fs.readdirSync(tmpDir).some((f) => f.startsWith('projects.json.corrupt-')),
    ).toBe(true);
    /* The healed registry is persisted, so the next reader is whole. */
    const again = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      projects: Record<string, unknown>;
    };
    expect(Object.keys(again.projects).sort()).toEqual([A_ID, B_ID]);
  });

  it('boot restore adds missing entries with live roots, skips dead roots and path dupes of a remote-scoped folder', async () => {
    const reg = await import('../src/identity/registry.js');
    const shared = mkRoot('shared');
    const gone = mkRoot('gone');
    /* Path-scoped first, then the remote-scoped twin for the same
     * folder (the two-"John Simms" shape); then a project whose folder
     * is about to disappear. */
    reg.recordIdentity({ id: A_ID, name: 'shared', root: shared, remote: null, scope: 'path' });
    reg.recordIdentity({
      id: B_ID,
      name: 'shared',
      root: shared,
      remote: 'https://example.invalid/shared',
      scope: 'remote',
    });
    reg.recordIdentity({ id: C_ID, name: 'gone', root: gone, remote: null, scope: 'path' });
    fs.rmSync(gone, { recursive: true, force: true });

    /* Simulate the wipe the bug produced: a valid but empty registry. */
    const file = path.posix.join(tmpDir, 'projects.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, projects: {} }), 'utf-8');

    const added = reg.restoreFromProjectMeta();
    expect(added).toEqual([B_ID]);
    const ids = reg.listProjects().map((p) => p.id);
    expect(ids).toEqual([B_ID]);
  });
});
