import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  daemonPackageRoot,
  launchDaemonOutsideHook,
  sanitizeDaemonEnv,
} from '../src/lifecycle/spawn.js';

/**
 * BUG-039 (2026-09-23). A hook-fired lazy spawn made the daemon a child
 * of the hook process. On Windows a child inherits every inheritable
 * handle of its parent, including the stdio pipes Claude Code gave the
 * hook through the silent shim, so the CLI's wait for the hook's pipe to
 * close lasted as long as the daemon lived: hours of "thinking" with
 * Escape doing nothing, after every daemon death or restart. The launch
 * must therefore never be a direct child of the hook on Windows; it goes
 * through the Task Scheduler (no inheritance), with a PowerShell
 * Start-Process fallback.
 */
describe('BUG-039: the daemon is never a child of the hook process', () => {
  const entry = 'C:/x/dist/daemon.js';
  const sidecarPath = path.join(os.tmpdir(), `devneural-spawn-test-${process.pid}.log`);
  const neverDirect = (() => {
    throw new Error('direct spawn must not happen on win32');
  }) as never;

  it('on Windows the launch goes through the scheduled task and node is never spawned directly', () => {
    const calls: Array<[string, string[], Record<string, unknown>]> = [];
    const spawnSyncFn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push([cmd, args, opts]);
      return { status: 0 };
    }) as never;
    const r = launchDaemonOutsideHook({ entry, sidecarPath, platform: 'win32', spawnSyncFn, spawnFn: neverDirect });
    expect(r.path).toBe('schtasks');
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('schtasks');
    expect(calls[0]![1]).toEqual(['/run', '/tn', 'DevNeural-Daemon']);
    expect(calls[0]![2].stdio).toBe('ignore');
  });

  it('falls back to a PowerShell Start-Process when the task cannot run, still never a direct child', () => {
    const calls: Array<[string, string[]]> = [];
    const spawnSyncFn = ((cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return cmd === 'schtasks' ? { status: 1 } : { status: 0 };
    }) as never;
    const r = launchDaemonOutsideHook({ entry, sidecarPath, platform: 'win32', spawnSyncFn, spawnFn: neverDirect });
    expect(r.path).toBe('powershell');
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toBe('powershell.exe');
    const cmd = calls[1]![1].join(' ');
    expect(cmd).toContain('Start-Process');
    expect(cmd).toContain(entry);
  });

  it('reports failed when both paths fail, and still does not spawn node', () => {
    const spawnSyncFn = (() => ({ status: 1 })) as never;
    const r = launchDaemonOutsideHook({ entry, sidecarPath, platform: 'win32', spawnSyncFn, spawnFn: neverDirect });
    expect(r.path).toBe('failed');
    expect(r.pid).toBeNull();
  });

  it('off Windows the detached direct spawn stays as it was', () => {
    const calls: Array<[string, string[], Record<string, unknown>]> = [];
    const spawnFn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push([cmd, args, opts]);
      return { pid: 4242, unref: () => undefined };
    }) as never;
    const spawnSyncFn = (() => {
      throw new Error('schtasks must not be used off win32');
    }) as never;
    const r = launchDaemonOutsideHook({ entry, sidecarPath, platform: 'linux', spawnSyncFn, spawnFn });
    expect(r.path).toBe('direct');
    expect(r.pid).toBe(4242);
    expect(calls[0]![0]).toBe(process.execPath);
    expect(calls[0]![1]).toEqual([entry]);
    expect(calls[0]![2].detached).toBe(true);
  });
});

/**
 * Regression: 2026-07-17. During an /admin/daemon/restart window a
 * hook-fired lazy spawn (ensureDaemonRunning) won the race against the
 * DevNeural-Daemon-Restart scheduled task. The spawn passed no cwd and
 * the raw hook process.env, so the daemon ran rooted at the REPO root
 * with a live Claude Code session's env (CLAUDECODE, CLAUDE_CODE_*,
 * VSCODE_*, ELECTRON_RUN_AS_NODE) for a full day. The wrong cwd moved
 * the voice-brain spawn cwd + transcript slug; the leaked env is the
 * same class of hazard the 2026-07-09 child-session fix guards at the
 * daemon -> Lex hop.
 */
describe('daemon lazy-spawn hygiene (2026-07-17 restart-race fix)', () => {
  it('daemonPackageRoot resolves to the 07-daemon package root', () => {
    expect(daemonPackageRoot().replace(/\\/g, '/')).toMatch(/\/07-daemon$/);
  });

  it('strips the launching session identity + IDE-host markers', () => {
    const out = sanitizeDaemonEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_TRANSCRIPT_PATH: 'C:/x.jsonl',
      CLAUDE_AGENT_SDK_VERSION: '0.3.210',
      CLAUDE_EFFORT: 'xhigh',
      VSCODE_PID: '47116',
      VSCODE_IPC_HOOK: 'pipe',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: 'C:/bin',
    });
    for (const k of [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_TRANSCRIPT_PATH',
      'CLAUDE_AGENT_SDK_VERSION',
      'CLAUDE_EFFORT',
      'VSCODE_PID',
      'VSCODE_IPC_HOOK',
      'ELECTRON_RUN_AS_NODE',
    ]) {
      expect(out[k]).toBeUndefined();
    }
    expect(out.PATH).toBe('C:/bin');
  });

  it('preserves config-scope + daemon vars', () => {
    const out = sanitizeDaemonEnv({
      CLAUDE_CONFIG_DIR: 'C:/Users/x/.claude',
      DEVNEURAL_VOICE_HAIKU: '1',
      BRIDGER_ANTHROPIC_API: 'key',
      HOME: 'C:/Users/x',
      CLAUDECODE: '1',
    });
    expect(out.CLAUDE_CONFIG_DIR).toBe('C:/Users/x/.claude');
    expect(out.DEVNEURAL_VOICE_HAIKU).toBe('1');
    expect(out.BRIDGER_ANTHROPIC_API).toBe('key');
    expect(out.HOME).toBe('C:/Users/x');
    expect(out.CLAUDECODE).toBeUndefined();
  });

  it('drops undefined values without crashing', () => {
    const out = sanitizeDaemonEnv({ A: 'x', B: undefined });
    expect(out.A).toBe('x');
    expect('B' in out).toBe(false);
  });
});
