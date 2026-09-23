/**
 * BUG-033 (2026-09-22): the Lex persona rode --append-system-prompt, so
 * Claude Code's own "You are Claude Code" identity led every Layer 1
 * turn and haiku answered "I'm Claude Code" under a direct question.
 * The voice replaces the default prompt; Layer 2 keeps appending (it
 * uses the tools the default prompt describes).
 */
import { describe, expect, it } from 'vitest';
import { systemPromptArgs } from '../src/dashboard/pty-host.js';

describe('systemPromptArgs (BUG-033)', () => {
  it('append keeps the old flag', () => {
    expect(systemPromptArgs('append', 'C:/t/p.txt')).toEqual([
      '--append-system-prompt',
      '@C:/t/p.txt',
    ]);
  });
  it('replace uses --system-prompt and drops the dynamic sections', () => {
    expect(systemPromptArgs('replace', 'C:/t/p.txt')).toEqual([
      '--system-prompt',
      '@C:/t/p.txt',
      '--exclude-dynamic-system-prompt-sections',
    ]);
  });
});
