import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProject, type CreateProjectDeps } from '../src/dashboard/projects-new.js';

/**
 * BUG-056 / BUG-057 (2026-09-28): Lex improvised the new-project scaffold
 * in shell, a settings deny blocked `rm -rf .git`, and the half-built
 * project kept `origin` pointing at the public dev-template with no
 * commit and no repo. createProject is now the one tested path: GitHub
 * creates the private repo from the template (fresh history, own
 * origin), the metadata is filled, committed and pushed.
 */
const TEMPLATE_JSONC = `{
  "name": "REPLACE_ME",
  "localPath": "REPLACE_ME",
  "githubUrl": "REPLACE_ME",
  "stage": "alpha",
  "tags": [],
  "description": "REPLACE_ME"
}
`;

let root: string;
let calls: Array<{ cmd: string; args: string[]; cwd: string }>;

function deps(over: Partial<CreateProjectDeps> = {}): CreateProjectDeps {
  return {
    projectsRoot: root,
    registerIdentity: () => undefined,
    run: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'create') {
        const dir = path.join(cwd, args[2]!);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'devneural.jsonc'), TEMPLATE_JSONC);
        return `https://github.com/someone/${args[2]}\n`;
      }
      if (cmd === 'git' && args[0] === 'remote') {
        return `https://github.com/someone/${path.basename(cwd)}.git\n`;
      }
      return '';
    },
    ...over,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-newproj-')).replace(/\\/g, '/');
  calls = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('createProject', () => {
  it('creates the private repo from the template, fills metadata, commits and pushes', async () => {
    const r = await createProject(
      {
        name: 'peax-pipeline-automation',
        description: 'Scrape job postings "fast"',
        tags: ['automation', 'scraping'],
        open_vscode: false,
      },
      deps(),
    );
    expect(r.ok).toBe(true);
    expect(r.path).toBe(`${root}/peax-pipeline-automation`);
    expect(r.github_url).toBe('https://github.com/someone/peax-pipeline-automation');

    const gh = calls.find((c) => c.cmd === 'gh')!;
    expect(gh.args).toEqual([
      'repo',
      'create',
      'peax-pipeline-automation',
      '--template',
      'Omnib0mb3r/dev-template',
      '--private',
      '--clone',
    ]);
    expect(gh.cwd).toBe(root);

    const cfg = fs.readFileSync(`${root}/peax-pipeline-automation/devneural.jsonc`, 'utf-8');
    expect(cfg).toContain('"name": "peax-pipeline-automation"');
    expect(cfg).toContain('"tags": ["automation", "scraping"]');
    expect(cfg).toContain(`"description": "Scrape job postings 'fast'"`);

    const git = calls.filter((c) => c.cmd === 'git').map((c) => c.args[0]);
    expect(git).toEqual(expect.arrayContaining(['add', 'commit', 'push']));
    expect(git.indexOf('commit')).toBeLessThan(git.indexOf('push'));
  });

  it('never deletes anything or re-inits git (the step a deny rule blocked)', async () => {
    await createProject({ name: 'abc-proj', open_vscode: false }, deps());
    expect(calls.some((c) => c.args.includes('init'))).toBe(false);
    expect(calls.some((c) => /rm|Remove-Item/.test(c.cmd))).toBe(false);
  });

  it('refuses a folder that already exists and runs nothing', async () => {
    fs.mkdirSync(`${root}/taken`);
    const r = await createProject({ name: 'taken', open_vscode: false }, deps());
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('rejects a non-kebab name before touching GitHub', async () => {
    const r = await createProject({ name: 'Peax Pipeline', open_vscode: false }, deps());
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reports a GitHub failure instead of leaving a half-built folder behind silently', async () => {
    const r = await createProject(
      { name: 'boom-proj', open_vscode: false },
      deps({
        run: (cmd) => {
          if (cmd === 'gh') throw new Error('gh: authentication required');
          return '';
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/gh repo create failed: gh: authentication required/);
  });
});
