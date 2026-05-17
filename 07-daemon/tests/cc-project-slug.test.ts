/* CC project-slug canonicalization + on-disk resolution.
 *
 * Pins the contracts:
 *   1. rootToSlug normalises backslashes, collapses slash runs,
 *      lowercases, strips trailing, swaps `:` / `/` / `\` for `-`.
 *      Output is fully lowercase and matches the form
 *      ~/.claude/projects/ stores its directory names in after the
 *      lowercase mask.
 *   2. resolveCcProjectDir scans the projects root and returns the
 *      directory whose lowercased name equals the canonical slug,
 *      preserving the on-disk casing.
 *   3. Drive-letter casing in the input cwd does not break the
 *      match: `c:/dev/...` and `C:\dev\...` both resolve to the
 *      same `C--dev-...` directory CC writes.
 *   4. resolveCcJsonlPath joins the resolved directory with the
 *      session id; returns null on a missing project dir.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveCcJsonlPath,
  resolveCcProjectDir,
  rootToSlug,
} from '../src/lex/cc-project-slug.js';

let tmpHome: string;
let projectsRoot: string;
const priorEnv: { HOME?: string; USERPROFILE?: string } = {};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-cc-slug-'));
  projectsRoot = path.join(tmpHome, '.claude', 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  priorEnv.HOME = process.env.HOME;
  priorEnv.USERPROFILE = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (priorEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = priorEnv.HOME;
  if (priorEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = priorEnv.USERPROFILE;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('rootToSlug', () => {
  it('lowercases, swaps separators + colon for hyphen', () => {
    expect(rootToSlug('C:\\dev\\Projects\\DevNeural')).toBe(
      'c--dev-projects-devneural',
    );
    expect(rootToSlug('C:/dev/Projects/DevNeural')).toBe(
      'c--dev-projects-devneural',
    );
    expect(rootToSlug('c:/dev/projects/devneural')).toBe(
      'c--dev-projects-devneural',
    );
  });

  it('collapses doubled separators', () => {
    expect(rootToSlug('C:\\\\dev\\Projects')).toBe('c--dev-projects');
    expect(rootToSlug('C://dev//Projects')).toBe('c--dev-projects');
  });

  it('strips a trailing slash', () => {
    expect(rootToSlug('C:/dev/Projects/DevNeural/')).toBe(
      'c--dev-projects-devneural',
    );
  });

  it('handles POSIX cwds without a drive letter', () => {
    expect(rootToSlug('/home/me/dev/devneural')).toBe('-home-me-dev-devneural');
  });
});

describe('resolveCcProjectDir', () => {
  it('returns the on-disk directory case when the cwd casing differs', () => {
    /* Simulate what CC writes on disk: drive letter uppercase, path
     * segments preserved from the cwd CC saw. */
    const realDir = path.join(projectsRoot, 'C--dev-Projects-DevNeural');
    fs.mkdirSync(realDir);
    /* Anchor row carries a lowercase-drive variant; the case-
     * insensitive scan must still find the real directory. */
    const got = resolveCcProjectDir('c:/dev/Projects/DevNeural');
    expect(got).not.toBeNull();
    expect(got!.endsWith('C--dev-Projects-DevNeural')).toBe(true);
  });

  it('returns null when no matching directory exists', () => {
    expect(resolveCcProjectDir('c:/dev/Projects/Nothing')).toBeNull();
  });

  it('returns null when the projects root does not exist', () => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    expect(resolveCcProjectDir('c:/dev/Projects/DevNeural')).toBeNull();
  });

  it('ignores non-directory entries with matching names', () => {
    /* A stray file with the matching name must NOT shadow the real
     * directory; the resolver requires a Dirent.isDirectory match. */
    fs.writeFileSync(
      path.join(projectsRoot, 'c--dev-projects-devneural'),
      'not a dir',
    );
    expect(resolveCcProjectDir('c:/dev/Projects/DevNeural')).toBeNull();
  });
});

describe('resolveCcJsonlPath', () => {
  it('joins the resolved directory with the session id', () => {
    const realDir = path.join(projectsRoot, 'C--dev-Projects-DevNeural');
    fs.mkdirSync(realDir);
    const got = resolveCcJsonlPath(
      'c:/dev/Projects/DevNeural',
      'abc-1234',
    );
    expect(got).not.toBeNull();
    expect(got!.endsWith('C--dev-Projects-DevNeural/abc-1234.jsonl')).toBe(true);
  });

  it('returns null when the session id is empty', () => {
    fs.mkdirSync(path.join(projectsRoot, 'C--dev-Projects-DevNeural'));
    expect(resolveCcJsonlPath('c:/dev/Projects/DevNeural', '')).toBeNull();
  });

  it('returns null when the project directory is missing', () => {
    expect(
      resolveCcJsonlPath('c:/dev/Projects/Nothing', 'abc-1234'),
    ).toBeNull();
  });
});
