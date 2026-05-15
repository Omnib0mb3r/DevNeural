import { spawn } from 'node:child_process';
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
    /* Pipe child stdout/stderr to a sidecar file, NOT daemon.log.
     * The daemon's own logger appends every line to daemon.log via
     * appendFileSync; if we also wired stderr into daemon.log here,
     * each logger() call would land twice (once via appendFile, once
     * via the inherited stderr fd). The sidecar captures any rogue
     * console output (uncaught throws, native warnings) that does
     * not go through logger. */
    const logPath = daemonLogFile().replace(/\.log$/, '.spawn.log');
    const out = fs.openSync(logPath, 'a');
    const err = fs.openSync(logPath, 'a');

    const entry = daemonEntryPath();
    if (!fs.existsSync(entry)) {
      // Daemon not built yet. Hooks should still capture; daemon will start later.
      return { started: false, pid: null };
    }

    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ['ignore', out, err],
      // Without windowsHide, every lazy-spawn from a hook creates a visible
      // console window for the daemon process. That's the flash users see
      // on every prompt. detached: true on Windows allocates a new console;
      // windowsHide: true tells CreateProcess to set SW_HIDE so the console
      // is created invisibly and stdio still gets redirected to the log.
      windowsHide: true,
      env: {
        ...process.env,
        DEVNEURAL_SPAWNED_BY_HOOK: '1',
      },
    });
    child.unref();

    return { started: true, pid: child.pid ?? null };
  } finally {
    lock.release();
  }
}
