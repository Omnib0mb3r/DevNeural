/**
 * Dashboard `next dev` supervisor.
 *
 * Owns the lifecycle of a single child process running
 * `08-dashboard/node_modules/next/dist/bin/next dev -p 3000` so the
 * dashboard rebuilds automatically while the daemon is up. Mirrors
 * the auto-advance + auto-ingest pattern: a register* function the
 * bootstrap calls once, returning a handle whose stop() the shutdown
 * closure awaits.
 *
 * Toggle: runtime_config row `dashboard_supervisor_enabled`. The row
 * wins when present; absent rows fall back to the
 * DEVNEURAL_DASHBOARD_SUPERVISOR env var, then to "on" by default.
 * CI=true forces off so test runs do not spin up a 3000 listener that
 * would clash with the daemon's own port or Playwright's webserver
 * pin.
 *
 * Restart loop: a child exit (any code, any signal) triggers a
 * scheduled respawn. Backoff doubles up to MAX_BACKOFF_MS when the
 * previous child died inside FAST_CRASH_THRESHOLD_MS (avoids a
 * tight crash loop saturating the daemon log when the dashboard
 * fails to compile); a long-lived child that exits gracefully resets
 * backoff to the minimum. stop() flips the stopped flag, clears any
 * pending respawn timer, kills the child (taskkill /t on Windows to
 * tear down the process tree because the next worker fork does not
 * inherit SIGTERM from npm's shim), and resolves after the child has
 * exited or a 5s deadline elapses.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IndexDb } from '../store/index-db.js';

export const DASHBOARD_SUPERVISOR_CONFIG_KEY = 'dashboard_supervisor_enabled';
export const DEFAULT_DASHBOARD_PORT = 3000;
export const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
export const FAST_CRASH_THRESHOLD_MS = 5_000;
export const STOP_GRACE_MS = 5_000;

/* Truthy/falsy string parser shared by runtime_config + env. Returns
 * null when the string does not parse so the caller can fall through
 * to the next source instead of treating "garbage" as false. */
function parseToggle(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
  return null;
}

export function isDashboardSupervisorEnabled(db: {
  getRuntimeConfig(key: string): string | null;
}): boolean {
  const fromDb = parseToggle(db.getRuntimeConfig(DASHBOARD_SUPERVISOR_CONFIG_KEY));
  if (fromDb !== null) return fromDb;
  const fromEnv = parseToggle(process.env.DEVNEURAL_DASHBOARD_SUPERVISOR ?? null);
  if (fromEnv !== null) return fromEnv;
  /* CI gate: only flips the default to off. An operator who has
   * already opted in via runtime_config or env still wins. Standard
   * CI providers set CI=true; treat any truthy CI value as a signal. */
  if (parseToggle(process.env.CI ?? null) === true) return false;
  return true;
}

export interface DashboardSupervisorOptions {
  db: { getRuntimeConfig(key: string): string | null };
  /** Absolute path to the 08-dashboard package root. */
  dashboardDir: string;
  log: (msg: string) => void;
  port?: number;
  /** Test seam. Defaults to node:child_process.spawn. */
  spawnImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
  /** Override for setTimeout/clearTimeout so tests can use fake timers. */
  scheduler?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
  /** Used by tests to inject deterministic backoff math. Defaults to Date.now. */
  now?: () => number;
}

export interface DashboardSupervisorHandle {
  stop(): Promise<void>;
  /** Diagnostics: current child pid or null when not running. */
  pid(): number | null;
  /** Diagnostics: total successful spawn attempts since start. */
  restartCount(): number;
  /** Diagnostics: whether the supervisor was disabled at boot. */
  isEnabled(): boolean;
}

const NOOP_HANDLE = (enabled: boolean): DashboardSupervisorHandle => ({
  stop: async () => undefined,
  pid: () => null,
  restartCount: () => 0,
  isEnabled: () => enabled,
});

export function startDashboardSupervisor(
  opts: DashboardSupervisorOptions,
): DashboardSupervisorHandle {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const now = opts.now ?? Date.now;
  const sched = opts.scheduler ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const spawnImpl = opts.spawnImpl ?? spawn;

  if (!isDashboardSupervisorEnabled(opts.db)) {
    opts.log(
      '[dashboard-supervisor] disabled (runtime_config / env / CI); not spawning next dev',
    );
    return NOOP_HANDLE(false);
  }

  const nextBin = path.join(
    opts.dashboardDir,
    'node_modules',
    'next',
    'dist',
    'bin',
    'next',
  );
  if (!fs.existsSync(nextBin)) {
    opts.log(
      `[dashboard-supervisor] next bin not found at ${nextBin}; supervisor disabled`,
    );
    return NOOP_HANDLE(false);
  }

  let child: ChildProcess | null = null;
  let stopped = false;
  let restarts = 0;
  let backoff = MIN_BACKOFF_MS;
  let lastSpawnAt = 0;
  let respawnTimer: unknown = null;
  let stopResolve: (() => void) | null = null;

  function clearRespawn(): void {
    if (respawnTimer !== null) {
      sched.clear(respawnTimer);
      respawnTimer = null;
    }
  }

  function scheduleRespawn(reason: string): void {
    if (stopped) return;
    const elapsed = now() - lastSpawnAt;
    if (elapsed < FAST_CRASH_THRESHOLD_MS) {
      backoff = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, backoff * 2));
    } else {
      backoff = MIN_BACKOFF_MS;
    }
    opts.log(
      `[dashboard-supervisor] respawn in ${backoff}ms (reason=${reason})`,
    );
    const handle = sched.set(() => {
      respawnTimer = null;
      spawnChild();
    }, backoff);
    if (typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
    respawnTimer = handle;
  }

  function spawnChild(): void {
    if (stopped) return;
    lastSpawnAt = now();
    restarts += 1;
    opts.log(
      `[dashboard-supervisor] spawning next dev -p ${port} (attempt #${restarts})`,
    );
    let c: ChildProcess;
    try {
      c = spawnImpl(
        process.execPath,
        [nextBin, 'dev', '-p', String(port)],
        {
          cwd: opts.dashboardDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            NODE_ENV: 'development',
          },
        },
      );
    } catch (err) {
      opts.log(
        `[dashboard-supervisor] spawn failed synchronously: ${(err as Error).message}`,
      );
      scheduleRespawn('spawn-throw');
      return;
    }
    child = c;
    c.stdout?.on('data', (buf: Buffer) => {
      const s = buf.toString('utf-8').trimEnd();
      if (s) opts.log(`[dashboard] ${s}`);
    });
    c.stderr?.on('data', (buf: Buffer) => {
      const s = buf.toString('utf-8').trimEnd();
      if (s) opts.log(`[dashboard-err] ${s}`);
    });
    c.on('exit', (code, signal) => {
      child = null;
      if (stopped) {
        if (stopResolve) {
          const r = stopResolve;
          stopResolve = null;
          r();
        }
        return;
      }
      const reason = signal ? `signal=${signal}` : `code=${code ?? 'unknown'}`;
      opts.log(`[dashboard-supervisor] child exited ${reason}`);
      scheduleRespawn(reason);
    });
    c.on('error', (err) => {
      opts.log(`[dashboard-supervisor] child error: ${err.message}`);
    });
  }

  spawnChild();

  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      stopped = true;
      clearRespawn();
      if (!child) {
        resolve();
        return;
      }
      stopResolve = resolve;
      try {
        if (process.platform === 'win32' && child.pid) {
          /* taskkill /t walks the process tree. next dev forks
           * compiler workers + a webpack child; SIGTERM on the
           * parent npm shim leaves those orphans alive until the
           * daemon process itself dies, which on Windows is "never"
           * because nothing reaps them. taskkill /f makes the
           * teardown deterministic. */
          const killer = spawnImpl(
            'taskkill',
            ['/pid', String(child.pid), '/t', '/f'],
            { windowsHide: true, stdio: 'ignore' },
          );
          killer.on?.('error', () => {
            try {
              child?.kill('SIGTERM');
            } catch {
              /* ignore */
            }
          });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        /* fall through to the deadline; child.on('exit') is what
         * actually resolves the promise so a kill that throws
         * (race with child already gone) is non-fatal. */
      }
      const deadline = sched.set(() => {
        if (child) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
        if (stopResolve) {
          const r = stopResolve;
          stopResolve = null;
          r();
        }
      }, STOP_GRACE_MS);
      if (typeof (deadline as { unref?: () => void }).unref === 'function') {
        (deadline as { unref: () => void }).unref();
      }
    });

  return {
    stop,
    pid: () => child?.pid ?? null,
    restartCount: () => restarts,
    isEnabled: () => true,
  };
}

/* Convenience for daemon.ts: resolve the dashboard package root
 * relative to the compiled daemon entry. dist/daemon.js -> dist
 * -> 07-daemon -> repo root -> 08-dashboard. The early HTML hook +
 * the static-serve block use the same arithmetic; centralising it
 * here keeps the supervisor's resolution honest if the repo layout
 * shifts. */
export function resolveDashboardDir(daemonFileUrl: string): string {
  const here = path.dirname(new URL(daemonFileUrl).pathname);
  /* On Windows the URL pathname leads with a slash (`/C:/...`).
   * path.resolve handles that on win32 but the leading slash makes
   * existsSync probe the wrong drive root. Strip it. */
  const cleaned = process.platform === 'win32' && here.startsWith('/')
    ? here.slice(1)
    : here;
  return path.resolve(cleaned, '..', '..', '08-dashboard');
}
