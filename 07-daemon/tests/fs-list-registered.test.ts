import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listDirsWithRegistration } from '../src/dashboard/fs-list.js';

/* 2026-10-03: the Add existing project picker showed every folder the
 * same, so the operator could not tell which ones were already on the
 * dashboard. Each folder now carries `registered`. */
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-fslist-')).replace(/\\/g, '/');
  for (const d of ['DevNeural', 'new-scraper', '.hidden']) fs.mkdirSync(`${root}/${d}`);
  fs.mkdirSync(`${root}/new-scraper/.git`);
  fs.writeFileSync(`${root}/notes.txt`, 'x');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listDirsWithRegistration', () => {
  it('marks a folder registered when a registry root matches it, ignoring case and slashes', () => {
    const regRoot = `${root}/devneural`.toLowerCase().replace(/\//g, '\\') + '\\';
    const dirs = listDirsWithRegistration(root, [regRoot]);
    expect(dirs.map((d) => [d.name, d.registered, d.has_git])).toEqual([
      ['DevNeural', true, false],
      ['new-scraper', false, true],
    ]);
  });

  it('skips files and dot-folders', () => {
    const names = listDirsWithRegistration(root, []).map((d) => d.name);
    expect(names).toEqual(['DevNeural', 'new-scraper']);
  });
});
