import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { showToast, _resetToastAvailability } from '../src/dashboard/toast-fallback.js';

beforeEach(() => {
  _resetToastAvailability();
});
afterEach(() => {
  _resetToastAvailability();
});

function fakeProc(opts: {
  exitCode: number;
  stderr?: string;
  emitError?: Error;
}) {
  const ee = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
  };
  (ee as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  setTimeout(() => {
    if (opts.emitError) {
      ee.emit('error', opts.emitError);
      return;
    }
    if (opts.stderr) {
      (ee as unknown as { stderr: EventEmitter }).stderr.emit(
        'data',
        Buffer.from(opts.stderr),
      );
    }
    ee.emit('close', opts.exitCode);
  }, 5);
  return ee;
}

describe('toast-fallback (OP-2)', () => {
  it('returns "shown" when powershell exits 0', async () => {
    const spawnImpl = (() => fakeProc({ exitCode: 0 })) as never;
    const r = await showToast({ title: 'Hi', body: 'Hello' }, { spawnImpl });
    expect(r).toBe('shown');
  });

  it('returns "unavailable" when BurntToast is missing', async () => {
    const stderr = "Import-Module : The specified module 'BurntToast' was not loaded.";
    const spawnImpl = (() => fakeProc({ exitCode: 1, stderr })) as never;
    const r = await showToast({ title: 'Hi' }, { spawnImpl });
    expect(r).toBe('unavailable');
  });

  it('returns "unavailable" when powershell spawn errors (ENOENT)', async () => {
    const spawnImpl = (() =>
      fakeProc({ exitCode: 0, emitError: new Error('spawn powershell ENOENT') })) as never;
    const r = await showToast({ title: 'Hi' }, { spawnImpl });
    expect(r).toBe('unavailable');
  });

  it('returns "failed" on a non-zero exit that is not the BurntToast-missing pattern', async () => {
    const spawnImpl = (() =>
      fakeProc({ exitCode: 1, stderr: 'unrelated error' })) as never;
    const r = await showToast({ title: 'Hi' }, { spawnImpl });
    expect(r).toBe('failed');
  });

  it('short-circuits after the first unavailable result', async () => {
    let calls = 0;
    const spawnImpl = (() => {
      calls += 1;
      return fakeProc({
        exitCode: 1,
        stderr: 'Import-Module BurntToast was not loaded',
      });
    }) as never;
    const r1 = await showToast({ title: 'Hi' }, { spawnImpl });
    expect(r1).toBe('unavailable');
    const r2 = await showToast({ title: 'Hi again' }, { spawnImpl });
    expect(r2).toBe('unavailable');
    expect(calls).toBe(1); // second call did not spawn
  });

  it('escapes single quotes in the title and body', async () => {
    let scriptArg = '';
    const spawnImpl = ((cmd: string, args: string[]) => {
      const cmdIdx = args.indexOf('-Command');
      scriptArg = args[cmdIdx + 1] ?? '';
      return fakeProc({ exitCode: 0 });
    }) as never;
    await showToast(
      { title: "it's a test", body: "don't break" },
      { spawnImpl },
    );
    expect(scriptArg).toContain("it''s a test");
    expect(scriptArg).toContain("don''t break");
  });
});
