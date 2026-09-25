/**
 * BUG-041 (2026-09-24): the boot-time probe that proves the installed
 * Claude Code still delivers a prompt file to the model. Pins the flag
 * shape (the file flag, never the dead `@<path>` form) and the verdicts.
 *
 * BUG-049 (2026-09-25): the probe spawns like a Layer 1 session (no
 * tools, no MCP servers, no user-scope settings, auto-updater off,
 * child-session markers stripped) and retries once after a failure.
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
    .mkdtempSync(path.join(os.tmpdir(), 'devneural-prompt-probe-'))
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

const noDelay = async (): Promise<void> => undefined;

describe('prompt delivery probe (BUG-041, BUG-049)', () => {
  it('passes the prompt through --system-prompt-file and reports ok on the marker', async () => {
    const mod = await import('../src/lex/prompt-delivery-probe.js');
    let seenArgs: string[] = [];
    const result = await mod.runPromptDeliveryProbe({
      log: () => undefined,
      delay: noDelay,
      run: async (args) => {
        seenArgs = args;
        return { stdout: 'LEX READY\n', stderr: '', code: 0 };
      },
    });
    expect(result.status).toBe('ok');
    expect(seenArgs).toContain('--system-prompt-file');
    expect(seenArgs.some((a) => a.startsWith('@'))).toBe(false);
    expect(seenArgs.some((a) => a === '--system-prompt')).toBe(false);
    const fileIdx = seenArgs.indexOf('--system-prompt-file');
    const promptFile = seenArgs[fileIdx + 1]!;
    expect(fs.readFileSync(promptFile, 'utf-8')).toContain('LEX READY');
    expect(mod.getPromptDeliveryStatus().status).toBe('ok');
  });

  it('spawns like a Layer 1 session: no tools, no MCP, no user-scope settings, updater off, markers stripped', async () => {
    const mod = await import('../src/lex/prompt-delivery-probe.js');
    const args = mod.probeArgs('C:/t/p.txt');
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual([
      '--setting-sources',
      'project,local',
    ]);
    /* Same strip as every Lex spawn (pty-host SPAWN_STRIP_ENV): the
     * child-session identity markers and the API-key billing override. */
    const env = mod.probeEnv({
      PATH: 'x',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_TRANSCRIPT_PATH: 'C:/t.jsonl',
      ANTHROPIC_API_KEY: 'sk-nope',
    });
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.PATH).toBe('x');
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_TRANSCRIPT_PATH).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('reports failed when the model answers as a bare assistant', async () => {
    const mod = await import('../src/lex/prompt-delivery-probe.js');
    const logs: string[] = [];
    const result = await mod.runPromptDeliveryProbe({
      log: (m) => logs.push(m),
      delay: noDelay,
      run: async () => ({
        stdout: "I'm ready to help! What would you like to work on?",
        stderr: '',
        code: 0,
      }),
    });
    expect(result.status).toBe('failed');
    expect(logs.some((l) => l.includes('[prompt-probe] FAILED'))).toBe(true);
    expect(mod.getPromptDeliveryStatus().status).toBe('failed');
  });

  it('retries once and reports ok when the second attempt passes', async () => {
    const mod = await import('../src/lex/prompt-delivery-probe.js');
    let calls = 0;
    const result = await mod.runPromptDeliveryProbe({
      log: () => undefined,
      delay: noDelay,
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('probe timed out after 180000ms');
        return { stdout: 'LEX READY\n', stderr: '', code: 0 };
      },
    });
    expect(calls).toBe(2);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('attempt 2');
  });

  it('reports failed when the CLI cannot be run twice', async () => {
    const mod = await import('../src/lex/prompt-delivery-probe.js');
    const result = await mod.runPromptDeliveryProbe({
      log: () => undefined,
      delay: noDelay,
      run: async () => {
        throw new Error('spawn claude ENOENT');
      },
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('ENOENT');
    expect(result.detail).toContain('attempt 2');
  });
});
