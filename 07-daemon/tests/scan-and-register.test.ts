/**
 * WP-F: /projects/scan-and-register route logic tests.
 *
 * Exercises scanAndRegisterProjects (exported from routes.ts) directly
 * against a real temp directory tree with real git repos, mirroring
 * how resolveProjectIdentity/recordIdentity behave in production
 * (real git shell-outs, a real projects.json on disk) -- the same
 * style tests/projects-routes.test.ts uses for the sibling anchor
 * routes.
 *
 * paths.ts's DATA_ROOT is a module-level const resolved from
 * process.env at import time (tests/transcript-watcher-catchup.test.ts
 * documents the same hazard in detail). A static top-level import of
 * routes.ts would freeze DATA_ROOT at the REAL production data root
 * before beforeEach ever runs. Every test here sets the env var,
 * resets the module registry, and dynamically imports routes.ts +
 * paths.ts, asserting DATA_ROOT actually landed on the temp dir
 * before doing anything that could touch real data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

let tmpDir: string;
let projectsRoot: string;
let priorDataRoot: string | undefined;

function gitInit(dir: string, remote?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const opts = { cwd: dir, stdio: 'ignore' as const, windowsHide: true };
  execSync('git init -q', opts);
  execSync('git config user.email test@test.local', opts);
  execSync('git config user.name test', opts);
  if (remote) {
    execSync(`git remote add origin ${remote}`, opts);
  }
}

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs
    .mkdtempSync(path.join(os.tmpdir(), 'devneural-scan-register-'))
    .replace(/\\/g, '/');
  projectsRoot = path.posix.join(tmpDir, 'Projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  priorDataRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  if (priorDataRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorDataRoot;
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scanAndRegisterProjects', () => {
  it('registers a fresh git repo, skips excluded/dot dirs and non-git dirs, and reports an already-registered repo as skipped', async () => {
    const pathsMod = await import('../src/paths.js');
    expect(pathsMod.DATA_ROOT).toBe(tmpDir);

    const routesMod = await import('../src/dashboard/routes.js');
    const identityMod = await import('../src/identity/project-id.js');
    const registryMod = await import('../src/identity/registry.js');

    fs.mkdirSync(path.posix.join(projectsRoot, 'Archive'));
    fs.mkdirSync(path.posix.join(projectsRoot, 'Holding'));
    fs.mkdirSync(path.posix.join(projectsRoot, 'tmp'));
    fs.mkdirSync(path.posix.join(projectsRoot, '.hidden'));

    // Plain folder, not a git repo at all -> no_identity.
    fs.mkdirSync(path.posix.join(projectsRoot, 'not-a-repo'));

    // Fresh git repo, no remote -> path-scoped identity, not yet known
    // to the registry -> registered.
    const freshRepo = path.posix.join(projectsRoot, 'fresh-repo');
    gitInit(freshRepo);

    // A repo whose identity the registry already knows about ->
    // already_registered.
    const preRegistered = path.posix.join(projectsRoot, 'pre-registered');
    gitInit(preRegistered);
    const preIdentity = identityMod.resolveProjectIdentity(preRegistered);
    registryMod.recordIdentity(preIdentity);

    const result = await routesMod.scanAndRegisterProjects(projectsRoot);

    expect(result.ok).toBe(true);
    expect(result.registered.map((r) => r.name)).toEqual(['fresh-repo']);

    const skippedByDir = Object.fromEntries(
      result.skipped.map((s) => [s.dir, s.reason]),
    );
    expect(skippedByDir['Archive']).toBe('excluded');
    expect(skippedByDir['Holding']).toBe('excluded');
    expect(skippedByDir['tmp']).toBe('excluded');
    expect(skippedByDir['.hidden']).toBe('excluded');
    expect(skippedByDir['not-a-repo']).toBe('no_identity');
    expect(skippedByDir['pre-registered']).toBe('already_registered');

    // The freshly-registered repo is now actually in the registry.
    expect(registryMod.getProject(result.registered[0]!.id)?.name).toBe(
      'fresh-repo',
    );
  });

  it('reports a shared-remote clone as already_registered (KNOWN COLLISION: undetached template clones)', async () => {
    const pathsMod = await import('../src/paths.js');
    expect(pathsMod.DATA_ROOT).toBe(tmpDir);
    const routesMod = await import('../src/dashboard/routes.js');

    /* Mirrors the documented ZsgAreaBlock vs dev-template collision:
     * two directories cloned from the same remote without detaching
     * .git hash to the SAME identity id. Whichever directory the scan
     * reaches first wins the id; the other is reported
     * already_registered even though it is a distinct folder. */
    const remote = 'https://github.com/Omnib0mb3r/dev-template';
    gitInit(path.posix.join(projectsRoot, 'dev-template'), remote);
    gitInit(path.posix.join(projectsRoot, 'zsg-area-block'), remote);

    const result = await routesMod.scanAndRegisterProjects(projectsRoot);

    expect(result.ok).toBe(true);
    expect(result.registered.length).toBe(1);
    expect(result.skipped.map((s) => s.reason)).toContain('already_registered');
    expect(new Set(result.registered.map((r) => r.id)).size).toBe(1);
  });

  it('honors a body.root override by walking that directory instead of the default', async () => {
    const pathsMod = await import('../src/paths.js');
    expect(pathsMod.DATA_ROOT).toBe(tmpDir);
    const routesMod = await import('../src/dashboard/routes.js');

    const altRoot = path.posix.join(tmpDir, 'AltProjects');
    const repo = path.posix.join(altRoot, 'alt-repo');
    gitInit(repo);

    const result = await routesMod.scanAndRegisterProjects(altRoot);
    expect(result.ok).toBe(true);
    expect(result.registered.map((r) => r.name)).toEqual(['alt-repo']);
  });

  it('returns ok:false with an error when root does not exist', async () => {
    const pathsMod = await import('../src/paths.js');
    expect(pathsMod.DATA_ROOT).toBe(tmpDir);
    const routesMod = await import('../src/dashboard/routes.js');

    const missing = path.posix.join(tmpDir, 'does-not-exist');
    const result = await routesMod.scanAndRegisterProjects(missing);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.registered).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
