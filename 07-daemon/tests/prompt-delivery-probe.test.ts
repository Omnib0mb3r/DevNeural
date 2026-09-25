/**
 * BUG-041 (2026-09-24): the boot-time probe that proves the installed
 * Claude Code still delivers a prompt file to the model. Pins the flag
 * shape (the file flag, never the dead `@<path>` form) and the verdicts.
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

describe('prompt delivery probe (BUG-041)', () => {
  it('passes the prompt through --system-prompt-file and reports ok on the marker', async () => {
    const mod = await import('../src/lex/prompt-delivery-probe.js');
    let seenArgs: string[] = [];
    const result = await mod.runPromptDeliveryProbe({
      log: () => undefined,
      run: async (args) => {
        seenArgs = args;
        return { stdout: 'LEX READY\n', code: 0 };
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

  it('reports failed when the model answers as a bare assistant', async () => {
    const mod = await import('../src/lex/prompt-delivery-probe.js');
    const logs: string[] = [];
    const result = await mod.runPromptDeliveryProbe({
      log: (m) => logs.push(m),
      run: async () => ({
        stdout: "I'm ready to help! What would you like to work on?",
        code: 0,
      }),
    });
    expect(result.status).toBe('failed');
    expect(logs.some((l) => l.includes('did NOT deliver the prompt file'))).toBe(true);
    expect(mod.getPromptDeliveryStatus().status).toBe('failed');
  });

  it('reports failed when the CLI cannot be run', async () => {
    const mod = await import('../src/lex/prompt-delivery-probe.js');
    const result = await mod.runPromptDeliveryProbe({
      log: () => undefined,
      run: async () => {
        throw new Error('spawn claude ENOENT');
      },
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('ENOENT');
  });
});
