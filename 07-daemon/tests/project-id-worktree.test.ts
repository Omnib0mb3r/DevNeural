import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveProjectIdentity } from '../src/identity/project-id.js';

/* 2026-10-03: a Claude session inside <project>/.claude/worktrees/<agent>
 * shares the project's remote, so it resolved to the same project id and
 * recordIdentity rewrote the project's root to the worktree. The
 * registry showed bridger-base-camp and New-Letter-and-TikToks rooted in
 * worktrees, and the Add-existing picker said their real folders were
 * not on the dashboard. Identity now resolves to the main working tree. */
let main: string;
let wt: string;
const git = (cwd: string, cmd: string) =>
  execSync(`git ${cmd}`, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-wt-')).replace(/\\/g, '/');
  main = `${base}/proj`;
  fs.mkdirSync(main);
  git(main, 'init -q -b main');
  git(main, 'config user.email t@t');
  git(main, 'config user.name t');
  fs.writeFileSync(`${main}/a.txt`, 'a');
  git(main, 'add a.txt');
  git(main, 'commit -q -m init');
  git(main, 'remote add origin https://github.com/someone/proj.git');
  wt = `${main}/.claude/worktrees/agent-x`;
  git(main, `worktree add -q "${wt}" -b agent-x`);
});

afterAll(() => {
  try {
    git(main, `worktree remove --force "${wt}"`);
  } catch {
    /* best-effort */
  }
  fs.rmSync(path.dirname(main), { recursive: true, force: true });
});

describe('resolveProjectIdentity in a git worktree', () => {
  it('roots the project at the main working tree, not the worktree', () => {
    const fromWt = resolveProjectIdentity(wt);
    const fromMain = resolveProjectIdentity(main);
    expect(fromWt.id).toBe(fromMain.id);
    expect(fromWt.root.toLowerCase()).toBe(main.toLowerCase());
    expect(fromWt.name).toBe('proj');
  });

  it('a normal checkout still roots at its own toplevel', () => {
    expect(resolveProjectIdentity(main).root.toLowerCase()).toBe(main.toLowerCase());
  });
});
