import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  daemonLogFile,
  ensureDataRoot,
} from '../paths.js';
import { acquireSpawnLock, readPid, isAlive } from './pid.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function daemonEntryPath(): string {
  // dist/lifecycle/spawn.js -> dist/daemon.js
  return path.resolve(__dirname, '..', 'daemon.js');
}

/* dist/lifecycle/spawn.js -> the 07-daemon package root. The daemon's
 * process.cwd() feeds voice-brain spawn cwd (and with it the transcript
 * slug the warmup watches), so a lazy spawn must match what
 * start-daemon.ps1 sets via -WorkingDirectory. 2026-07-17: a hook-fired
 * lazy spawn won the restart race with no cwd option and the daemon ran
 * a whole day rooted at the REPO root instead. */
export function daemonPackageRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/* The lazy spawn runs inside a hook, i.e. inside a live Claude Code
 * session, so process.env carries that session's identity and IDE-host
 * markers (CLAUDECODE, CLAUDE_CODE_*, CLAUDE_TRANSCRIPT_PATH, VSCODE_*,
 * ELECTRON_RUN_AS_NODE). A daemon launched by Task Scheduler has none
 * of them; strip them here so both launch paths hand the daemon the
 * same environment. Config-scope vars stay (CLAUDE_CONFIG_DIR,
 * ANTHROPIC_*, DEVNEURAL_*) - same contract as pty-host's
 * sanitizeClaudeSpawnEnv, which guards the NEXT hop (daemon -> Lex PTY)
 * and stays in place as defense in depth. */
export function sanitizeDaemonEnv(
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k === 'CLAUDE_CONFIG_DIR') {
      env[k] = v;
      continue;
    }
    if (/^(CLAUDE|VSCODE_)/.test(k) || k === 'ELECTRON_RUN_AS_NODE') continue;
    env[k] = v;
  }
  return env;
}

export function ensureDaemonRunning(): { started: boolean; pid: number | null } {
  const existing = readPid();
  if (existing !== null && isAlive(existing)) {
    return { started: false, pid: existing };
  }

  const lock = acquireSpawnLock();
  if (!lock) {
    // Another hook already racing to spawn. Don't double-spawn.
    return { started: false, pid: null };
  }

  try {
    const recheck = readPid();
    if (recheck !== null && isAlive(recheck)) {
      return { started: false, pid: recheck };
    }

    ensureDataRoot();
    const entry = daemonEntryPath();
    if (!fs.existsSync(entry)) {
      // Daemon not built yet. Hooks should still capture; daemon will start later.
      return { started: false, pid: null };
    }

    const r = launchDaemonOutsideHook({
      entry,
      sidecarPath: daemonLogFile().replace(/\.log$/, '.spawn.log'),
    });
    return { started: r.path !== 'failed', pid: r.pid };
  } finally {
    lock.release();
  }
}

export const DAEMON_TASK_NAME = 'DevNeural-Daemon';

export type DaemonLaunchPath = 'schtasks' | 'powershell' | 'direct' | 'failed';

export interface DaemonLaunchArgs {
  /** dist/daemon.js */
  entry: string;
  /** Where the direct path sends the child's stdout and stderr. */
  sidecarPath: string;
  platform?: NodeJS.Platform;
  spawnSyncFn?: typeof spawnSync;
  spawnFn?: typeof spawn;
  taskName?: string;
}

/* BUG-039 (2026-09-23): the daemon must never be a child of the hook
 * process on Windows.
 *
 * A hook runs under Claude Code with its stdio on pipes (through the
 * silent shim). A Windows child inherits every inheritable handle of its
 * parent, and node's spawn does not restrict that set, so a daemon
 * spawned here kept the CLI's pipe write-ends open for its whole life.
 * Claude Code waits for the hook's pipe to close before it moves on, so
 * every daemon death or restart turned the next tool call into a hang
 * of hours: "thinking", Escape ignored, until the daemon or VS Code was
 * killed. detached and unref do not help; the handles are the leak.
 *
 * So on Windows the launch goes through the Task Scheduler
 * (`schtasks /run /tn DevNeural-Daemon`, the same task the restart
 * route arms and the logon autostart uses): the daemon becomes a child
 * of the scheduler service and inherits nothing from the hook. If the
 * task cannot run, PowerShell's Start-Process is the fallback (it does
 * not pass handles either). Off Windows the direct detached spawn stays,
 * with the sidecar and the env hygiene from 2026-07-17. */
export function launchDaemonOutsideHook(args: DaemonLaunchArgs): {
  path: DaemonLaunchPath;
  pid: number | null;
} {
  const platform = args.platform ?? process.platform;
  if (platform === 'win32') {
    const spawnSyncFn = args.spawnSyncFn ?? spawnSync;
    const taskName = args.taskName ?? DAEMON_TASK_NAME;
    const viaTask = spawnSyncFn('schtasks', ['/run', '/tn', taskName], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    });
    if (!viaTask.error && viaTask.status === 0) return { path: 'schtasks', pid: null };

    const psCommand =
      `Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' ` +
      `-ArgumentList '"${args.entry}"' ` +
      `-WorkingDirectory '${daemonPackageRoot().replace(/'/g, "''")}' -WindowStyle Hidden`;
    const viaPs = spawnSyncFn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', psCommand],
      { stdio: 'ignore', windowsHide: true, timeout: 8_000 },
    );
    if (!viaPs.error && viaPs.status === 0) return { path: 'powershell', pid: null };
    return { path: 'failed', pid: null };
  }

  /* Pipe child stdout/stderr to a sidecar file, NOT daemon.log.
   * The daemon's own logger appends every line to daemon.log via
   * appendFileSync; if we also wired stderr into daemon.log here,
   * each logger() call would land twice (once via appendFile, once
   * via the inherited stderr fd). The sidecar captures any rogue
   * console output (uncaught throws, native warnings) that does
   * not go through logger. */
  const out = fs.openSync(args.sidecarPath, 'a');
  const err = fs.openSync(args.sidecarPath, 'a');
  const spawnFn = args.spawnFn ?? spawn;
  const child = spawnFn(process.execPath, [args.entry], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
    cwd: daemonPackageRoot(),
    env: sanitizeDaemonEnv(process.env),
  });
  child.unref();
  return { path: 'direct', pid: child.pid ?? null };
}
