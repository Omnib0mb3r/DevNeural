import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  normalizeRemote,
  hashId,
  normalizeFsRoot,
  resolveProjectIdentity,
  resolveProjectIdentityForRegistration,
} from '../src/identity/project-id.js';

describe('normalizeRemote', () => {
  it('strips .git suffix and trailing slash', () => {
    expect(normalizeRemote('https://github.com/User/Repo.git/')).toBe(
      'https://github.com/user/repo',
    );
  });

  it('converts SSH github form to https', () => {
    expect(normalizeRemote('git@github.com:User/Repo.git')).toBe(
      'https://github.com/user/repo',
    );
  });

  it('lowercases', () => {
    expect(normalizeRemote('HTTPS://GitHub.com/Foo/Bar')).toBe(
      'https://github.com/foo/bar',
    );
  });
});

describe('hashId', () => {
  it('is 12 hex chars', () => {
    const id = hashId('https://github.com/foo/bar');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable for the same input', () => {
    const a = hashId('https://github.com/foo/bar');
    const b = hashId('https://github.com/foo/bar');
    expect(a).toBe(b);
  });

  it('differs for different inputs', () => {
    const a = hashId('https://github.com/foo/bar');
    const b = hashId('https://github.com/foo/baz');
    expect(a).not.toBe(b);
  });
});

/* BUG-021 (2026-08-26): non-git folders could not be registered.
 * resolveProjectIdentity returns `global` for any directory git cannot
 * claim, which is correct on the capture path but made
 * POST /projects/register-path 422 and scan-and-register silently skip
 * every folder without a .git. resolveProjectIdentityForRegistration
 * adds the filesystem-path fallback for those operator-initiated routes
 * only. */
const tempRoots: string[] = [];

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), `dn-${label}-`));
  tempRoots.push(dir);
  return normalizeFsRoot(dir);
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('normalizeFsRoot', () => {
  it('forward-slashes and strips trailing slashes', () => {
    expect(normalizeFsRoot('C:\\dev\\Projects\\foo\\')).toBe(
      'C:/dev/Projects/foo',
    );
  });

  it('tolerates repeated trailing slashes', () => {
    expect(normalizeFsRoot('C:/dev/Projects/foo///')).toBe(
      'C:/dev/Projects/foo',
    );
  });
});

describe('resolveProjectIdentityForRegistration', () => {
  it('claims a non-git folder that the plain resolver drops', () => {
    const dir = makeTempDir('nogit');

    // The capture-path resolver must still refuse it...
    expect(resolveProjectIdentity(dir).id).toBe('global');

    // ...while explicit registration mints a path-scoped identity.
    const identity = resolveProjectIdentityForRegistration(dir);
    expect(identity.id).not.toBe('global');
    expect(identity.id).toMatch(/^[0-9a-f]{12}$/);
    expect(identity.scope).toBe('path');
    expect(identity.remote).toBeNull();
    expect(identity.name).toBe(nodePath.basename(dir));
    expect(identity.root).toBe(dir);
  });

  it('is stable across slash direction, trailing slash and casing', () => {
    const dir = makeTempDir('stable');
    const base = resolveProjectIdentityForRegistration(dir).id;

    expect(resolveProjectIdentityForRegistration(`${dir}/`).id).toBe(base);
    expect(
      resolveProjectIdentityForRegistration(dir.replace(/\//g, '\\')).id,
    ).toBe(base);
    expect(resolveProjectIdentityForRegistration(dir.toUpperCase()).id).toBe(
      base,
    );
  });

  it('gives distinct folders distinct ids', () => {
    const a = resolveProjectIdentityForRegistration(makeTempDir('a')).id;
    const b = resolveProjectIdentityForRegistration(makeTempDir('b')).id;
    expect(a).not.toBe(b);
  });

  it('still returns global for a path that does not exist', () => {
    const missing = `${makeTempDir('missing')}/definitely-not-here`;
    expect(resolveProjectIdentityForRegistration(missing).id).toBe('global');
  });

  it('returns global for empty input', () => {
    expect(resolveProjectIdentityForRegistration('').id).toBe('global');
  });

  it('defers to git when the folder IS a repo with a remote', () => {
    const dir = makeTempDir('withremote');
    execSync('git init -q', { cwd: dir, windowsHide: true });
    execSync('git remote add origin git@github.com:Foo/Bar.git', {
      cwd: dir,
      windowsHide: true,
    });

    const identity = resolveProjectIdentityForRegistration(dir);
    expect(identity.scope).toBe('remote');
    expect(identity.remote).toBe('https://github.com/foo/bar');
    expect(identity.id).toBe(hashId('https://github.com/foo/bar'));
  });

  /* Id continuity is the reason the fallback hashes a normalized,
   * lowercased path: registering a bare folder and THEN running
   * `git init` in it must not produce two registry entries for one
   * folder. A later `git remote add` does change the id by design, and
   * registry.reconcilePathDupes folds the path-scoped entry in. */
  it('keeps the same id after git init with no remote', () => {
    const dir = makeTempDir('initlater');
    const before = resolveProjectIdentityForRegistration(dir).id;

    execSync('git init -q', { cwd: dir, windowsHide: true });

    const after = resolveProjectIdentityForRegistration(dir);
    expect(after.scope).toBe('path');
    expect(after.remote).toBeNull();
    expect(after.id).toBe(before);
    // and the plain capture-path resolver now agrees, too
    expect(resolveProjectIdentity(dir).id).toBe(before);
  });
});
