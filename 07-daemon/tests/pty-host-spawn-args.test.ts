/**
 * BUG-033 (2026-09-22): the Lex persona rode --append-system-prompt, so
 * Claude Code's own "You are Claude Code" identity led every Layer 1
 * turn and haiku answered "I'm Claude Code" under a direct question.
 * The voice replaces the default prompt; Layer 2 keeps appending (it
 * uses the tools the default prompt describes).
 *
 * BUG-041 (2026-09-24): the `@<path>` form stopped being expanded by
 * Claude Code 2.1.273, so the literal "@C:/.../abc.txt" became the whole
 * prompt and every Lex session ran as a bare assistant. Both modes must
 * use the CLI's file flags and must never emit an `@`-prefixed value.
 */
import { describe, expect, it } from 'vitest';
import { systemPromptArgs } from '../src/dashboard/pty-host.js';

describe('systemPromptArgs (BUG-033, BUG-041)', () => {
  it('append uses the file flag', () => {
    expect(systemPromptArgs('append', 'C:/t/p.txt')).toEqual([
      '--append-system-prompt-file',
      'C:/t/p.txt',
    ]);
  });
  it('replace uses the file flag and drops the dynamic sections', () => {
    expect(systemPromptArgs('replace', 'C:/t/p.txt')).toEqual([
      '--system-prompt-file',
      'C:/t/p.txt',
      '--exclude-dynamic-system-prompt-sections',
    ]);
  });
  it('never emits the dead @<path> form in either mode', () => {
    for (const mode of ['append', 'replace'] as const) {
      const args = systemPromptArgs(mode, 'C:/t/p.txt');
      expect(args.some((a) => a.startsWith('@'))).toBe(false);
      expect(args.some((a) => a === '--system-prompt' || a === '--append-system-prompt')).toBe(false);
    }
  });
});
