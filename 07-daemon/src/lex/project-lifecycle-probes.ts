/* Project lifecycle gate probes (DRIVE-QUEUE 3).
 *
 * The side-effecting half of the gate exit criteria: gathers objective
 * signals about a project's working dir (intake, spec doc, tests, test
 * runner, suite green, open bugs) that the PURE gateProbe in
 * project-lifecycle.ts turns into a satisfied/not verdict.
 *
 * Bounded + safe: the filesystem walk is depth- and count-capped and
 * skips heavy dirs (node_modules / .git / build output) so a probe over a
 * large repo stays cheap. Running the suite (suiteGreen) is OPT-IN only -
 * the GET endpoint does cheap fs probes by default and runs the test
 * command only when explicitly asked, so a probe never silently kicks off
 * a multi-minute build. Every seam is injectable for tests.
 */
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { execSync } from 'node:child_process';
import type { GateSignals } from './project-lifecycle.js';

const WALK_MAX_DEPTH = 4;
const WALK_MAX_FILES = 4000;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  'build',
  'coverage',
  '.turbo',
]);
/* Opt-in suite run ceiling. windowsHide per the project's subprocess
 * rule (no console flash). */
const TEST_TIMEOUT_MS = Number(
  process.env.DEVNEURAL_LIFECYCLE_TEST_TIMEOUT_MS ?? 180_000,
);

export interface ProbeEnv {
  exists: (p: string) => boolean;
  isDir: (p: string) => boolean;
  readText: (p: string) => string | null;
  /** Bounded recursive file path list under dir (relative names ok). */
  walk: (dir: string) => string[];
  /** Run the project's test command. ok=true on exit 0. Returns null when
   * there is no runnable test command. */
  runTests: (cwd: string) => { ok: boolean; ms: number } | null;
}

function defaultExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
function defaultIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function defaultReadText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function defaultWalk(root: string): string[] {
  const out: string[] = [];
  const rootNorm = root.replace(/\\/g, '/');
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: rootNorm, depth: 0 },
  ];
  while (stack.length > 0 && out.length < WALK_MAX_FILES) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = nodePath.posix.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (depth < WALK_MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
      } else {
        out.push(full);
        if (out.length >= WALK_MAX_FILES) break;
      }
    }
  }
  return out;
}

function defaultRunTests(cwd: string): { ok: boolean; ms: number } | null {
  const pkgRaw = defaultReadText(nodePath.posix.join(cwd.replace(/\\/g, '/'), 'package.json'));
  if (!pkgRaw) return null;
  let hasTestScript = false;
  try {
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    hasTestScript = Boolean(pkg.scripts?.test);
  } catch {
    return null;
  }
  if (!hasTestScript) return null;
  const t0 = Date.now();
  try {
    execSync('npm test', {
      cwd,
      stdio: 'ignore',
      windowsHide: true,
      timeout: TEST_TIMEOUT_MS,
    });
    return { ok: true, ms: Date.now() - t0 };
  } catch {
    return { ok: false, ms: Date.now() - t0 };
  }
}

export function defaultProbeEnv(): ProbeEnv {
  return {
    exists: defaultExists,
    isDir: defaultIsDir,
    readText: defaultReadText,
    walk: defaultWalk,
    runTests: defaultRunTests,
  };
}

const SPEC_RE = /(^|\/)[^/]*spec[^/]*\.md$/i;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const STATUS_OPEN_RE = /status:?\*{0,2}\s*open/i;

/* Gather the objective gate signals for a project working dir. Cheap fs
 * probes by default; the suite is run only when opts.runTests is true. */
export function gatherGateSignals(
  cwd: string,
  opts: { env?: Partial<ProbeEnv>; runTests?: boolean } = {},
): GateSignals {
  const env: ProbeEnv = { ...defaultProbeEnv(), ...opts.env };
  const root = cwd.replace(/\\/g, '/');
  const join = (rel: string) => nodePath.posix.join(root, rel);

  const hasIntake =
    env.exists(join('README.md')) ||
    env.exists(join('package.json')) ||
    env.exists(join('project.json'));

  const files = env.walk(root);

  const hasSpecDoc =
    env.isDir(join('docs/spec')) ||
    files.some((f) => SPEC_RE.test(f));

  const hasTests =
    env.isDir(join('tests')) ||
    env.isDir(join('test')) ||
    files.some((f) => TEST_FILE_RE.test(f));

  let hasTestRunner = false;
  const pkgRaw = env.readText(join('package.json'));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
      hasTestRunner = Boolean(pkg.scripts?.test);
    } catch {
      hasTestRunner = false;
    }
  }

  /* Open bugs: count docs/bugs/*.md whose body still reads Status: open. */
  let openBugs: number | null = null;
  if (env.isDir(join('docs/bugs'))) {
    openBugs = 0;
    for (const f of files) {
      if (!/\/docs\/bugs\/[^/]+\.md$/i.test(f)) continue;
      const body = env.readText(f);
      if (body && STATUS_OPEN_RE.test(body)) openBugs += 1;
    }
  }

  let suiteGreen: boolean | null = null;
  if (opts.runTests) {
    const r = env.runTests(root);
    suiteGreen = r ? r.ok : null;
  }

  return { hasIntake, hasSpecDoc, hasTests, hasTestRunner, suiteGreen, openBugs };
}
