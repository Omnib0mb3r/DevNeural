/**
 * WP-I-b: /admin/daemon/restart relauncher choice (armRelauncher,
 * routes.ts).
 *
 * Every test injects a fake spawnFn (mirrors the EventEmitter-based
 * stub pattern in tests/toast-fallback.test.ts) so nothing here ever
 * calls the REAL node:child_process spawn. That matters more than
 * usual for this route: the real primary path is
 *   spawn('schtasks', ['/run', '/tn', 'DevNeural-Daemon'], ...)
 * and 'DevNeural-Daemon' is the actual autostart task name installed
 * on real dev machines by scripts/install-daemon-autostart.ps1 -- an
 * un-stubbed test run here could genuinely trigger a real scheduled
 * task run against a real daemon. Every case below supplies spawnFn
 * explicitly; none exercises the default real `spawn`.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { armRelauncher } from '../src/dashboard/routes.js';

const TASK_NAME = 'DevNeural-Daemon';
const START_SCRIPT = 'C:/dev/Projects/DevNeural/07-daemon/scripts/start-daemon.ps1';

function fakeChild(): EventEmitter & { unref: () => void } {
  const ee = new EventEmitter() as EventEmitter & { unref: () => void };
  ee.unref = () => undefined;
  return ee;
}

describe('armRelauncher', () => {
  it('prefers schtasks and never touches the powershell fallback on a clean spawn', () => {
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
    expect(calls[0]!.args).toEqual(['/run', '/tn', TASK_NAME]);
    expect(logs).toHaveLength(0);
  });

  it('falls back to the powershell start-daemon.ps1 spawn when schtasks throws synchronously', () => {
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
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe('schtasks');
    expect(calls[1]!.cmd).toBe('powershell.exe');
    expect(calls[1]!.args).toContain('-Command');
    const inline = calls[1]!.args[calls[1]!.args.length - 1] as string;
    expect(inline).toContain('start-daemon.ps1');
    expect(inline).toContain('-Force');
    expect(inline).toContain('Start-Sleep');
    expect(logs.some((m) => m.includes('RELAUNCH FAILED'))).toBe(true);
  });

  it('returns failed and logs loudly when both schtasks and the powershell fallback throw synchronously', () => {
    const spawnFn = (() => {
      throw new Error('spawn ENOENT');
    }) as never;
    const logs: string[] = [];

    const strategy = armRelauncher(TASK_NAME, START_SCRIPT, {
      spawnFn,
      log: (m) => logs.push(m),
    });

    expect(strategy).toBe('failed');
    expect(logs.filter((m) => m.includes('RELAUNCH FAILED')).length).toBeGreaterThanOrEqual(2);
  });

  it('attaches an error handler to the schtasks child and falls back when it fires asynchronously', () => {
    const calls: { cmd: string }[] = [];
    const children: EventEmitter[] = [];
    const spawnFn = ((cmd: string) => {
      calls.push({ cmd });
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

    /* Simulate the schtasks child reporting a spawn error after the
     * synchronous spawn() call already returned -- how Node actually
     * reports ENOENT-class failures (part (a) of WP-I-b: attach
     * .on('error') and log loudly). */
    children[0]!.emit('error', new Error('schtasks not recognized'));

    expect(calls).toHaveLength(2);
    expect(calls[1]!.cmd).toBe('powershell.exe');
    expect(
      logs.some((m) => m.includes('RELAUNCH FAILED') && m.includes('schtasks')),
    ).toBe(true);
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
