/* Dashboard `next dev` supervisor.
 *
 * Pins the contracts that matter for the bootstrap:
 *   1. Toggle resolution. runtime_config row > env var > CI default;
 *      unparseable strings fall through.
 *   2. Disabled supervisor returns a no-op handle and never spawns.
 *   3. Missing next bin returns a no-op handle (no respawn loop on a
 *      box where the dashboard package was not installed).
 *   4. Spawn arguments and cwd are correct (next bin path, dev flag,
 *      port, dashboardDir cwd).
 *   5. Restart on exit happens with a doubled backoff when the crash
 *      was fast; resets to MIN_BACKOFF_MS after a long-lived run.
 *   6. stop() kills the child and prevents a further respawn even
 *      when a respawn timer was already pending.
 *
 * Spawning and scheduling are injected so the test never starts a
 * real next dev or relies on real timers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isDashboardSupervisorEnabled,
  isOwnDashboardCommandLine,
  EADDR_BACKOFF_BASE_MS,
  EADDR_MAX_ATTEMPTS,
  MIN_BACKOFF_MS,
  startDashboardSupervisor,
  type PortConflictOps,
} from '../src/dashboard/dashboard-supervisor.js';

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 50_000) + 10_000;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killSignals: string[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    if (signal !== undefined) this.killSignals.push(String(signal));
    return true;
  }
}

interface PendingTimer {
  fn: () => void;
  ms: number;
}

function makeScheduler() {
  const pending: PendingTimer[] = [];
  return {
    sched: {
      set(fn: () => void, ms: number): unknown {
        const entry: PendingTimer = { fn, ms };
        pending.push(entry);
        return entry;
      },
      clear(handle: unknown): void {
        const idx = pending.indexOf(handle as PendingTimer);
        if (idx >= 0) pending.splice(idx, 1);
      },
    },
    runFirst(): void {
      const e = pending.shift();
      if (!e) throw new Error('no pending timers');
      e.fn();
    },
    pending,
  };
}

function makeFakeDb(value: string | null) {
  return { getRuntimeConfig: (_k: string) => value };
}

function makeDashboardDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-dash-sup-'));
  const binDir = path.join(tmp, 'node_modules', 'next', 'dist', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'next'), '#!/usr/bin/env node\n');
  return tmp;
}

describe('isDashboardSupervisorEnabled', () => {
  const origCI = process.env.CI;
  const origEnv = process.env.DEVNEURAL_DASHBOARD_SUPERVISOR;
  afterEach(() => {
    if (origCI === undefined) delete process.env.CI;
    else process.env.CI = origCI;
    if (origEnv === undefined) delete process.env.DEVNEURAL_DASHBOARD_SUPERVISOR;
    else process.env.DEVNEURAL_DASHBOARD_SUPERVISOR = origEnv;
  });

  it('runtime_config row wins over env and CI', () => {
    process.env.CI = 'true';
    process.env.DEVNEURAL_DASHBOARD_SUPERVISOR = 'off';
    expect(isDashboardSupervisorEnabled(makeFakeDb('on'))).toBe(true);
    expect(isDashboardSupervisorEnabled(makeFakeDb('off'))).toBe(false);
  });

  it('env wins over CI when the row is unset', () => {
    process.env.CI = 'true';
    process.env.DEVNEURAL_DASHBOARD_SUPERVISOR = 'on';
    expect(isDashboardSupervisorEnabled(makeFakeDb(null))).toBe(true);
  });

  it('CI=true forces off when row and env are unset', () => {
    delete process.env.DEVNEURAL_DASHBOARD_SUPERVISOR;
    process.env.CI = 'true';
    expect(isDashboardSupervisorEnabled(makeFakeDb(null))).toBe(false);
  });

  it('defaults to on with no row, env, or CI', () => {
    delete process.env.DEVNEURAL_DASHBOARD_SUPERVISOR;
    delete process.env.CI;
    expect(isDashboardSupervisorEnabled(makeFakeDb(null))).toBe(true);
  });

  it('ignores unparseable strings (falls through to env)', () => {
    delete process.env.CI;
    delete process.env.DEVNEURAL_DASHBOARD_SUPERVISOR;
    expect(isDashboardSupervisorEnabled(makeFakeDb('maybe'))).toBe(true);
  });
});

describe('startDashboardSupervisor', () => {
  let dir: string;
  const origCI = process.env.CI;
  const origEnv = process.env.DEVNEURAL_DASHBOARD_SUPERVISOR;
  beforeEach(() => {
    dir = makeDashboardDir();
    delete process.env.CI;
    delete process.env.DEVNEURAL_DASHBOARD_SUPERVISOR;
  });
  afterEach(() => {
    if (origCI === undefined) delete process.env.CI;
    else process.env.CI = origCI;
    if (origEnv === undefined) delete process.env.DEVNEURAL_DASHBOARD_SUPERVISOR;
    else process.env.DEVNEURAL_DASHBOARD_SUPERVISOR = origEnv;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns a noop handle when disabled and never spawns', () => {
    let spawned = 0;
    const sup = startDashboardSupervisor({
      db: makeFakeDb('off'),
      dashboardDir: dir,
      log: () => undefined,
      spawnImpl: () => {
        spawned += 1;
        return new FakeChild() as unknown as ChildProcess;
      },
    });
    expect(sup.isEnabled()).toBe(false);
    expect(sup.pid()).toBe(null);
    expect(spawned).toBe(0);
  });

  it('returns a noop handle when the next bin is missing', () => {
    let spawned = 0;
    const sup = startDashboardSupervisor({
      db: makeFakeDb('on'),
      dashboardDir: path.join(dir, '__missing__'),
      log: () => undefined,
      spawnImpl: () => {
        spawned += 1;
        return new FakeChild() as unknown as ChildProcess;
      },
    });
    expect(sup.isEnabled()).toBe(false);
    expect(spawned).toBe(0);
  });

  it('spawns with the correct args and cwd', () => {
    const calls: Array<{
      cmd: string;
      args: readonly string[];
      opts: SpawnOptions;
    }> = [];
    startDashboardSupervisor({
      db: makeFakeDb('on'),
      dashboardDir: dir,
      log: () => undefined,
      spawnImpl: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return new FakeChild() as unknown as ChildProcess;
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).toBe(process.execPath);
    expect(calls[0]!.args).toEqual([
      path.join(dir, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '-p',
      '3000',
    ]);
    expect(calls[0]!.opts.cwd).toBe(dir);
    expect(calls[0]!.opts.windowsHide).toBe(true);
  });

  it('respawns on exit with doubled backoff after a fast crash', () => {
    const sched = makeScheduler();
    let nowMs = 0;
    const children: FakeChild[] = [];
    startDashboardSupervisor({
      db: makeFakeDb('on'),
      dashboardDir: dir,
      log: () => undefined,
      spawnImpl: () => {
        const c = new FakeChild();
        children.push(c);
        return c as unknown as ChildProcess;
      },
      scheduler: sched.sched,
      now: () => nowMs,
    });
    expect(children.length).toBe(1);
    /* Fast crash inside FAST_CRASH_THRESHOLD_MS. */
    nowMs = 1_000;
    children[0]!.emit('exit', 1, null);
    expect(sched.pending.length).toBe(1);
    expect(sched.pending[0]!.ms).toBe(MIN_BACKOFF_MS * 2);
    sched.runFirst();
    expect(children.length).toBe(2);
    /* Another fast crash doubles again. */
    nowMs = 2_000;
    children[1]!.emit('exit', 1, null);
    expect(sched.pending[0]!.ms).toBe(MIN_BACKOFF_MS * 4);
  });

  it('resets backoff after a long-lived run', () => {
    const sched = makeScheduler();
    let nowMs = 0;
    const children: FakeChild[] = [];
    startDashboardSupervisor({
      db: makeFakeDb('on'),
      dashboardDir: dir,
      log: () => undefined,
      spawnImpl: () => {
        const c = new FakeChild();
        children.push(c);
        return c as unknown as ChildProcess;
      },
      scheduler: sched.sched,
      now: () => nowMs,
    });
    nowMs = 100;
    children[0]!.emit('exit', 1, null);
    expect(sched.pending[0]!.ms).toBe(MIN_BACKOFF_MS * 2);
    sched.runFirst();
    /* second child stays up for 60s before exiting */
    nowMs = 60_100;
    children[1]!.emit('exit', 0, null);
    expect(sched.pending[0]!.ms).toBe(MIN_BACKOFF_MS);
  });

  it('stop kills the child and prevents any further respawn', async () => {
    const sched = makeScheduler();
    const children: FakeChild[] = [];
    const killCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    function fakeSpawn(
      cmd: string,
      args: readonly string[],
    ): ChildProcess {
      if (cmd === 'taskkill') {
        killCalls.push({ cmd, args });
        const k = new FakeChild();
        return k as unknown as ChildProcess;
      }
      const c = new FakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    }
    const sup = startDashboardSupervisor({
      db: makeFakeDb('on'),
      dashboardDir: dir,
      log: () => undefined,
      spawnImpl: fakeSpawn,
      scheduler: sched.sched,
      now: () => 0,
    });
    expect(sup.restartCount()).toBe(1);
    const stopP = sup.stop();
    /* simulate child exit in response to the kill */
    children[0]!.emit('exit', null, 'SIGTERM');
    await stopP;
    if (process.platform === 'win32') {
      expect(killCalls[0]?.args).toEqual([
        '/pid',
        String(children[0]!.pid),
        '/t',
        '/f',
      ]);
    } else {
      expect(children[0]!.killSignals).toContain('SIGTERM');
    }
    /* The exit event arrived AFTER stopped flipped, so no respawn
     * timer should be queued. The only pending entry would be the
     * stop deadline timer; assert no respawn was triggered. */
    expect(sup.restartCount()).toBe(1);
  });
});

/* 2026-07-16 live failure 2: an orphaned next-dev (its daemon was
 * hard-killed without shutdown) held :3000 and every respawned child
 * died EADDRINUSE every 30s forever - no detection, no reclaim, no
 * escalation. These pin the conflict path. */
describe('EADDRINUSE port-conflict handling', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeDashboardDir();
    delete process.env.CI;
    delete process.env.DEVNEURAL_DASHBOARD_SUPERVISOR;
  });
  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const settle = async (): Promise<void> => {
    /* handlePortConflict awaits the (resolved) fake ops; drain the
     * microtask queue so its scheduling lands before assertions. */
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  function makeConflictOps(opts: {
    holderPid: number | null;
    commandLine: string | null;
    killOk?: boolean;
  }): { ops: PortConflictOps; killed: number[] } {
    const killed: number[] = [];
    return {
      killed,
      ops: {
        findListenerPid: async () => opts.holderPid,
        getCommandLine: async () => opts.commandLine,
        killTree: async (pid) => {
          killed.push(pid);
          return opts.killOk ?? true;
        },
      },
    };
  }

  function startRig(ops: PortConflictOps) {
    const sched = makeScheduler();
    const children: FakeChild[] = [];
    const logs: string[] = [];
    startDashboardSupervisor({
      db: makeFakeDb('on'),
      dashboardDir: dir,
      log: (m) => logs.push(m),
      spawnImpl: () => {
        const c = new FakeChild();
        children.push(c);
        return c as unknown as ChildProcess;
      },
      scheduler: sched.sched,
      now: () => 0,
      portConflictOps: ops,
    });
    return { sched, children, logs };
  }

  function crashWithEaddrinuse(c: FakeChild): void {
    c.stderr.emit(
      'data',
      Buffer.from('Error: listen EADDRINUSE: address already in use :::3000'),
    );
    c.emit('exit', 0, null);
  }

  it('reclaims the port from our own orphaned dashboard: tree-kill + immediate respawn', async () => {
    const { ops, killed } = makeConflictOps({
      holderPid: 106480,
      commandLine: `"C:\\Program Files\\nodejs\\node.exe" ${dir}\\node_modules\\next\\dist\\server\\lib\\start-server.js`,
    });
    const { sched, children, logs } = startRig(ops);
    crashWithEaddrinuse(children[0]!);
    await settle();

    expect(killed).toEqual([106480]);
    expect(sched.pending.length).toBe(1);
    expect(sched.pending[0]!.ms).toBe(MIN_BACKOFF_MS);
    expect(logs.some((l) => l.includes('ORPHANED dashboard'))).toBe(true);
    sched.runFirst();
    expect(children.length).toBe(2);
  });

  it('a foreign holder is never killed; backoff escalates per conflict', async () => {
    const { ops, killed } = makeConflictOps({
      holderPid: 4242,
      commandLine: 'C:\\SomeOtherApp\\server.exe --port 3000',
    });
    const { sched, children } = startRig(ops);

    crashWithEaddrinuse(children[0]!);
    await settle();
    expect(killed).toEqual([]);
    expect(sched.pending[0]!.ms).toBe(EADDR_BACKOFF_BASE_MS);

    sched.runFirst();
    crashWithEaddrinuse(children[1]!);
    await settle();
    expect(sched.pending[0]!.ms).toBe(EADDR_BACKOFF_BASE_MS * 2);
  });

  it('gives up permanently (loud log, no timer) after the attempt cap', async () => {
    const { ops } = makeConflictOps({
      holderPid: 4242,
      commandLine: 'C:\\SomeOtherApp\\server.exe',
    });
    const { sched, children, logs } = startRig(ops);
    for (let i = 0; i < EADDR_MAX_ATTEMPTS; i++) {
      crashWithEaddrinuse(children[children.length - 1]!);
      await settle();
      if (i < EADDR_MAX_ATTEMPTS - 1) {
        expect(sched.pending.length).toBe(1);
        sched.runFirst();
      }
    }
    expect(sched.pending.length).toBe(0);
    expect(logs.some((l) => l.includes('PERMANENTLY UNAVAILABLE'))).toBe(true);
  });

  it('a failed reclaim kill falls back to the foreign-holder backoff', async () => {
    const { ops, killed } = makeConflictOps({
      holderPid: 106480,
      commandLine: `node ${dir}/node_modules/next/dist/bin/next dev -p 3000`,
      killOk: false,
    });
    const { sched, children } = startRig(ops);
    crashWithEaddrinuse(children[0]!);
    await settle();
    expect(killed).toEqual([106480]);
    expect(sched.pending[0]!.ms).toBe(EADDR_BACKOFF_BASE_MS);
  });

  it('no holder found (transient TIME_WAIT) backs off without giving up early', async () => {
    const { ops } = makeConflictOps({ holderPid: null, commandLine: null });
    const { sched, children } = startRig(ops);
    crashWithEaddrinuse(children[0]!);
    await settle();
    expect(sched.pending.length).toBe(1);
    expect(sched.pending[0]!.ms).toBe(EADDR_BACKOFF_BASE_MS);
  });
});

describe('isOwnDashboardCommandLine', () => {
  it('matches the orphan shape from the live incident (start-server.js under the dashboard dir)', () => {
    expect(
      isOwnDashboardCommandLine(
        '"C:\\Program Files\\nodejs\\node.exe" C:\\dev\\Projects\\DevNeural\\08-dashboard\\node_modules\\next\\dist\\server\\lib\\start-server.js',
        'C:\\dev\\Projects\\DevNeural\\08-dashboard',
      ),
    ).toBe(true);
  });

  it('matches regardless of slash direction and case', () => {
    expect(
      isOwnDashboardCommandLine(
        'node c:/dev/projects/devneural/08-dashboard/node_modules/next/dist/bin/next dev -p 3000',
        'C:\\dev\\Projects\\DevNeural\\08-dashboard',
      ),
    ).toBe(true);
  });

  it('rejects foreign processes and null command lines', () => {
    expect(
      isOwnDashboardCommandLine(
        'C:\\SomeOtherApp\\server.exe --port 3000',
        'C:\\dev\\Projects\\DevNeural\\08-dashboard',
      ),
    ).toBe(false);
    expect(
      isOwnDashboardCommandLine(null, 'C:\\dev\\Projects\\DevNeural\\08-dashboard'),
    ).toBe(false);
  });
});
