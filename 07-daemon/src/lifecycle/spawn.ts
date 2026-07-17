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
      cwd: daemonPackageRoot(),
      env: {
        ...sanitizeDaemonEnv(process.env),
        DEVNEURAL_SPAWNED_BY_HOOK: '1',
      },
    });
    child.unref();

    return { started: true, pid: child.pid ?? null };
  } finally {
    lock.release();
  }
}
