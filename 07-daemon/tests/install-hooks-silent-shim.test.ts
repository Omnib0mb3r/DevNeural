/**
 * R1 regression pin: every hook phase must route through silent-shim.exe,
 * not wscript.exe + a VBScript shim.
 *
 * Root cause (curator-loop revival, root cause R1): buildCommand() used to
 * emit `wscript.exe "<dist>/capture/hooks/silent-runner.vbs" <phase>` for
 * every phase. WshShell.Run (inside that VBS) does not pipe stdin to the
 * child process, so hook-runner.js received an empty JSON payload on every
 * phase wrapped this way — 7,803 user_prompt observations landed with
 * prompt='' and session='unknown'. silent-shim.exe (scripts/silent-shim/
 * Program.cs) is the only wrapper that both hides the console window
 * (CreateNoWindow=true) and forwards stdin/stdout/stderr
 * (RedirectStandardInput/Output/Error=true).
 *
 * These tests exercise buildCommand as a pure string formatter (the shim
 * path is injected, not resolved from disk) so they do not depend on
 * whether silent-shim.exe has actually been dotnet-published on the
 * machine running the suite.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCommand,
  isDevNeuralEntry,
  HOOK_PHASES,
} from '../src/capture/hooks/install-hooks.js';

const FAKE_SHIM = 'C:/fake/07-daemon/scripts/silent-shim/bin/silent-shim.exe';

describe('buildCommand (R1 silent-shim wiring)', () => {
  it('routes every declared hook phase through silent-shim.exe, never wscript/vbs', () => {
    expect(HOOK_PHASES.length).toBeGreaterThan(0);
    for (const { phase } of HOOK_PHASES) {
      const command = buildCommand(phase, FAKE_SHIM);
      expect(command.toLowerCase()).not.toContain('wscript');
      expect(command.toLowerCase()).not.toContain('.vbs');
      expect(command).toContain('silent-shim.exe');
      expect(command).toContain('hook-runner.js');
      expect(command).toContain(phase);
    }
  });

  it.each(['pre', 'post', 'prompt', 'stop', 'notification', 'session_start'])(
    'wraps phase "%s" as "<shim>" "node \\"<hook-runner>\\" <phase>"',
    (phase) => {
      const command = buildCommand(phase, FAKE_SHIM);
      const shimWin = FAKE_SHIM.replace(/\//g, '\\');
      expect(command.startsWith(`"${shimWin}" "node \\"`)).toBe(true);
      expect(command.endsWith(`\\" ${phase}"`)).toBe(true);
    },
  );

  it('backslash-escapes embedded quotes rather than cmd-style doubling', () => {
    const command = buildCommand('prompt', FAKE_SHIM);
    // The inner command is quoted once; embedded quotes must be \" not "".
    expect(command).not.toMatch(/""/);
    expect(command).toMatch(/\\"/);
  });

  it('normalizes forward slashes in the shim path to backslashes', () => {
    const command = buildCommand('stop', 'C:/some/forward/slash/silent-shim.exe');
    expect(command.startsWith('"C:\\some\\forward\\slash\\silent-shim.exe"')).toBe(true);
  });
});

describe('isDevNeuralEntry recognizes silent-shim-wrapped entries', () => {
  it('detects a silent-shim.exe-wrapped hook-runner.js command as a DevNeural entry', () => {
    const command = buildCommand('post', FAKE_SHIM);
    expect(isDevNeuralEntry({ type: 'command', command })).toBe(true);
  });

  it('still detects the legacy wscript/vbs shape so re-install replaces it', () => {
    const legacy =
      'wscript.exe "C:\\dev\\Projects\\DevNeural\\07-daemon\\dist\\capture\\hooks\\silent-runner.vbs" pre';
    expect(isDevNeuralEntry({ type: 'command', command: legacy })).toBe(true);
  });

  it('does not flag an unrelated command', () => {
    expect(
      isDevNeuralEntry({ type: 'command', command: 'node C:/some/other/tool.js' }),
    ).toBe(false);
  });
});
