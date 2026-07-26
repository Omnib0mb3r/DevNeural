/**
 * Claude Code trust-gate pre-seed (see
 * docs/bugs/2026-07-26-start-claude-blocked-by-trust-prompt.md).
 *
 * Covers the ~/.claude.json project-key normalization and the
 * best-effort seedProjectTrust read-modify-write: fresh-file creation,
 * preservation of unrelated projects and existing entry fields, and the
 * already-trusted no-write short-circuit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claudeProjectKey,
  seedProjectTrust,
} from '../src/dashboard/projects-new.js';

let counter = 0;
const created: string[] = [];
function tmpConfig(): string {
  const p = path.posix.join(
    os.tmpdir().replace(/\\/g, '/'),
    `dn-claude-json-${process.pid}-${counter++}.json`,
  );
  created.push(p);
  return p;
}

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('claudeProjectKey', () => {
  it('uppercases the drive letter and forward-slashes backslashes', () => {
    expect(claudeProjectKey('c:\\dev\\Projects\\foo')).toBe(
      'C:/dev/Projects/foo',
    );
  });
  it('uppercases a lowercase drive on an already-forward-slash path', () => {
    expect(claudeProjectKey('c:/dev/Projects/dropship-01')).toBe(
      'C:/dev/Projects/dropship-01',
    );
  });
  it('leaves an already-canonical key unchanged', () => {
    expect(claudeProjectKey('C:/dev/Projects/foo')).toBe('C:/dev/Projects/foo');
  });
});

describe('seedProjectTrust', () => {
  it('creates the config and trusts a brand-new folder', () => {
    const cfgPath = tmpConfig();
    const changed = seedProjectTrust('c:/dev/Projects/newthing', cfgPath);
    expect(changed).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const entry = cfg.projects['C:/dev/Projects/newthing'];
    expect(entry.hasTrustDialogAccepted).toBe(true);
    expect(entry.hasCompletedProjectOnboarding).toBe(true);
  });

  it('preserves unrelated projects and existing entry fields', () => {
    const cfgPath = tmpConfig();
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        someTopLevel: 'keep-me',
        projects: {
          'C:/dev/Projects/other': { hasTrustDialogAccepted: true, foo: 1 },
          'C:/dev/Projects/mine': { allowedTools: ['Bash'] },
        },
      }),
      'utf-8',
    );
    const changed = seedProjectTrust('C:/dev/Projects/mine', cfgPath);
    expect(changed).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(cfg.someTopLevel).toBe('keep-me');
    expect(cfg.projects['C:/dev/Projects/other']).toEqual({
      hasTrustDialogAccepted: true,
      foo: 1,
    });
    expect(cfg.projects['C:/dev/Projects/mine'].allowedTools).toEqual(['Bash']);
    expect(cfg.projects['C:/dev/Projects/mine'].hasTrustDialogAccepted).toBe(
      true,
    );
    expect(
      cfg.projects['C:/dev/Projects/mine'].hasCompletedProjectOnboarding,
    ).toBe(true);
  });

  it('is a no-op when the folder is already fully trusted', () => {
    const cfgPath = tmpConfig();
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        projects: {
          'C:/dev/Projects/mine': {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      }),
      'utf-8',
    );
    const before = fs.readFileSync(cfgPath, 'utf-8');
    const changed = seedProjectTrust('C:/dev/Projects/mine', cfgPath);
    expect(changed).toBe(false);
    expect(fs.readFileSync(cfgPath, 'utf-8')).toBe(before);
  });

  it('never throws on an unwritable config path', () => {
    // A path whose parent dir does not exist makes the write fail; the
    // function must swallow it and report no change rather than throw.
    const bad = path.posix.join(
      os.tmpdir().replace(/\\/g, '/'),
      'dn-no-such-dir-xyz',
      'nested',
      '.claude.json',
    );
    expect(() => seedProjectTrust('C:/dev/Projects/mine', bad)).not.toThrow();
    expect(seedProjectTrust('C:/dev/Projects/mine', bad)).toBe(false);
  });
});
