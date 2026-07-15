/**
 * WP-I-b + restart-hang fix: /admin/daemon/restart relauncher chain
 * (armRelauncher, routes.ts).
 *
 * Chain under test: on-demand -Force restart task
 * ('DevNeural-Daemon-Restart', relaunches in seconds) -> safety-net
 * autostart task ('DevNeural-Daemon', worst case next 5-minute tick)
 * -> direct powershell start-daemon.ps1 -Force spawn. Each hop fires
 * only when the previous spawn itself errors (sync throw or async
 * 'error' event).
 *
 * Every test injects a fake spawnFn (mirrors the EventEmitter-based
 * stub pattern in tests/toast-fallback.test.ts) so nothing here ever
 * calls the REAL node:child_process spawn: both task names are real
 * scheduled tasks on real dev machines, and an un-stubbed run could
 * genuinely trigger a real relaunch against a real daemon.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { armRelauncher } from '../src/dashboard/routes.js';

const TASK_NAME = 'DevNeural-Daemon';
const RESTART_TASK = 'DevNeural-Daemon-Restart';
const START_SCRIPT = 'C:/dev/Projects/DevNeural/07-daemon/scripts/start-daemon.ps1';

function fakeChild(): EventEmitter & { unref: () => void } {
  const ee = new EventEmitter() as EventEmitter & { unref: () => void };
  ee.unref = () => undefined;
  return ee;
}

describe('armRelauncher', () => {
  it('fires the on-demand restart task first and nothing else on a clean spawn', () => {
    const calls: { cmd: string; args: unknown[] }[] = [];
    const spawnFn = ((cmd: string, args: unknown[]) => {
      calls.push({ cmd, args });
      return fakeChild();
    }) as never;
    const logs: string[] = [];

    const strategy = armRelauncher(TASK_NAME, START_SCRIPT, {
      spawnFn,
      log: (m) => logs.push(m),
    });

    expect(strategy).toBe('schtasks');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('schtasks');
    expect(calls[0]!.args).toEqual(['/run', '/tn', RESTART_TASK]);
    expect(logs).toHaveLength(0);
  });

  it('walks restart task -> safety task -> powershell when schtasks throws synchronously', () => {
    const calls: { cmd: string; args: unknown[] }[] = [];
    const spawnFn = ((cmd: string, args: unknown[]) => {
      calls.push({ cmd, args });
      if (cmd === 'schtasks') throw new Error('schtasks ENOENT');
      return fakeChild();
    }) as never;
    const logs: string[] = [];

    const strategy = armRelauncher(TASK_NAME, START_SCRIPT, {
      spawnFn,
      log: (m) => logs.push(m),
    });

    expect(strategy).toBe('powershell');
    expect(calls).toHaveLength(3);
    expect(calls[0]!.args).toEqual(['/run', '/tn', RESTART_TASK]);
    expect(calls[1]!.args).toEqual(['/run', '/tn', TASK_NAME]);
    expect(calls[2]!.cmd).toBe('powershell.exe');
    expect(calls[2]!.args).toContain('-Command');
    const inline = calls[2]!.args[calls[2]!.args.length - 1] as string;
    expect(inline).toContain('start-daemon.ps1');
    expect(inline).toContain('-Force');
    expect(inline).toContain('Start-Sleep');
    expect(
      logs.filter((m) => m.includes('trying next relaunch path')).length,
    ).toBe(2);
  });

  it('returns failed and logs loudly when every hop throws synchronously', () => {
    const spawnFn = (() => {
      throw new Error('spawn ENOENT');
    }) as never;
    const logs: string[] = [];

    const strategy = armRelauncher(TASK_NAME, START_SCRIPT, {
      spawnFn,
      log: (m) => logs.push(m),
    });

    expect(strategy).toBe('failed');
    expect(
      logs.filter((m) => m.includes('trying next relaunch path')).length,
    ).toBe(2);
    expect(logs.some((m) => m.includes('RELAUNCH FAILED'))).toBe(true);
  });

  it('attaches error handlers to each schtasks child and walks the chain on async errors', () => {
    const calls: { cmd: string; args: unknown[] }[] = [];
    const children: EventEmitter[] = [];
    const spawnFn = ((cmd: string, args: unknown[]) => {
      calls.push({ cmd, args });
      const child = fakeChild();
      children.push(child);
      return child;
    }) as never;
    const logs: string[] = [];

    const strategy = armRelauncher(TASK_NAME, START_SCRIPT, {
      spawnFn,
      log: (m) => logs.push(m),
    });
    expect(strategy).toBe('schtasks');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['/run', '/tn', RESTART_TASK]);

    /* Node reports ENOENT-class spawn failures asynchronously; each
     * hop must catch its child's 'error' event and fire the next. */
    children[0]!.emit('error', new Error('restart task not recognized'));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(['/run', '/tn', TASK_NAME]);

    children[1]!.emit('error', new Error('safety task not recognized'));
    expect(calls).toHaveLength(3);
    expect(calls[2]!.cmd).toBe('powershell.exe');
    expect(
      logs.filter((m) => m.includes('trying next relaunch path')).length,
    ).toBe(2);
  });

  it('attaches an error handler to the powershell fallback child too', () => {
    const children: EventEmitter[] = [];
    const spawnFn = ((cmd: string) => {
      if (cmd === 'schtasks') throw new Error('schtasks ENOENT');
      const child = fakeChild();
      children.push(child);
      return child;
    }) as never;
    const logs: string[] = [];

    armRelauncher(TASK_NAME, START_SCRIPT, { spawnFn, log: (m) => logs.push(m) });
    expect(children).toHaveLength(1);

    children[0]!.emit('error', new Error('powershell.exe ENOENT'));

    expect(
      logs.some((m) => m.includes('RELAUNCH FAILED') && m.includes('powershell fallback')),
    ).toBe(true);
  });

  it('defaults log to a no-op when none is supplied', () => {
    const spawnFn = (() => {
      throw new Error('spawn ENOENT');
    }) as never;
    expect(() => armRelauncher(TASK_NAME, START_SCRIPT, { spawnFn })).not.toThrow();
  });
});
