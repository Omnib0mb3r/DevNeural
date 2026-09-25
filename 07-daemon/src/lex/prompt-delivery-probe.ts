/**
 * Prompt-delivery probe (BUG-041, 2026-09-24).
 *
 * Every Lex session gets its identity and contract from a prompt file
 * handed to Claude Code on the command line. Claude Code auto-updates
 * underneath the daemon, and 2.1.273 stopped expanding the `@<path>`
 * form the daemon had used since May: the literal "@C:/.../abc.txt"
 * became the whole prompt and every Lex session booted as a bare
 * assistant. Nothing in the daemon could tell; the sessions spawned,
 * warmed and answered, just not as Lex.
 *
 * This probe makes that class of regression visible after boot. It
 * writes a one-line prompt file that says "reply with exactly
 * LEX READY", runs one throwaway `claude -p` with the same flags the
 * sessions use (--system-prompt-file, --tools "", --strict-mcp-config,
 * --setting-sources project,local), and checks the reply. The result
 * lands in daemon.log and in GET /health as `prompt_delivery`.
 *
 * BUG-049 (2026-09-25): the first version ran at the instant of boot
 * with the default MCP and settings scope and a bare timeout. Twice it
 * "timed out" at 120 s while the claude child sat waiting (5 s of CPU
 * in ten minutes, no transcript ever written) and outlived the kill,
 * which only reached the cmd.exe wrapper. The same command from an
 * interactive shell answers in 14 s. So the probe now spawns exactly
 * like a Layer 1 session (no MCP servers, no user-scope settings, the
 * auto-updater off, the child-session markers stripped), starts after
 * the boot storm (the transcript watcher's initial scan, next dev's
 * first compile), kills the whole process tree on timeout, retries
 * once, and logs what the child said on stderr.
 *
 * Costs one haiku call per daemon boot. Skipped under Vitest, CI, and
 * when DEVNEURAL_PROMPT_PROBE=0.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_ROOT } from '../paths.js';
import { sanitizeClaudeSpawnEnv, systemPromptArgs } from '../dashboard/pty-host.js';

export const PROMPT_PROBE_MARKER = 'LEX READY';
const PROBE_PROMPT =
  'You are the DevNeural prompt-delivery probe. Whatever the user says, reply with exactly: LEX READY';
export const PROBE_TIMEOUT_MS = 180_000;
/** Boot storm: the transcript watcher's initial scan of ~/.claude/projects
 * runs about 90 s on this box and next dev compiles alongside it. */
export const PROBE_BOOT_DELAY_MS = 45_000;
export const PROBE_RETRY_DELAY_MS = 5 * 60_000;

export type PromptDeliveryStatus =
  | { status: 'pending'; checked_at: null; detail: string }
  | { status: 'skipped'; checked_at: string; detail: string }
  | { status: 'ok'; checked_at: string; detail: string; elapsed_ms: number }
  | { status: 'failed'; checked_at: string; detail: string; elapsed_ms: number };

let current: PromptDeliveryStatus = {
  status: 'pending',
  checked_at: null,
  detail: 'probe not run yet',
};

export function getPromptDeliveryStatus(): PromptDeliveryStatus {
  return current;
}

/** Test seam. */
export function _resetPromptDeliveryForTests(): void {
  current = { status: 'pending', checked_at: null, detail: 'probe not run yet' };
}

function quoteWindowsArg(a: string): string {
  if (a === '') return '""';
  if (!/[\s"]/.test(a)) return a;
  return `"${a.replace(/"/g, '\\"')}"`;
}

export interface ProbeRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface ProbeDeps {
  log: (msg: string) => void;
  /** Override the spawn for tests. */
  run?: (args: string[], cwd: string, env: Record<string, string>) => Promise<ProbeRunResult>;
  /** Override the scheduling for tests (default: real timers, unref'd). */
  delay?: (ms: number) => Promise<void>;
}

/** The env a probe child gets: the daemon's, minus the child-session
 * markers and the API key (same strip as every Lex spawn), plus the
 * auto-updater switched off so a probe can never sit behind a 40 MB
 * download or an npm-to-native migration. Exported for the pin. */
export function probeEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  return { ...sanitizeClaudeSpawnEnv(base), DISABLE_AUTOUPDATER: '1' };
}

/** The argv of the probe: the Layer 1 spawn's shape (no tools, no MCP,
 * no user-scope settings) plus the prompt file and the fixed probe
 * message. Exported for the pin. */
export function probeArgs(promptFile: string): string[] {
  return [
    '-p',
    '--model',
    'haiku',
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    'project,local',
    ...systemPromptArgs('replace', promptFile),
    'Warmup check.',
  ];
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/f', '/t', '/pid', String(pid)], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => undefined);
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

function defaultRun(
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<ProbeRunResult> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    /* `claude` is a shim on Windows; run it through cmd.exe so PATHEXT
     * resolution applies, same as pty-host's spawnLex. */
    const exe = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'claude';
    const spawnArgs = isWindows
      ? ['/d', '/s', '/c', ['claude', ...args].map(quoteWindowsArg).join(' ')]
      : args;
    const child = spawn(exe, spawnArgs, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8');
    });
    const timer = setTimeout(() => {
      killTree(child.pid);
      reject(
        new Error(
          `probe timed out after ${PROBE_TIMEOUT_MS}ms (pid ${child.pid ?? '?'}); stderr=${JSON.stringify(stderr.slice(-300))}`,
        ),
      );
    }, PROBE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });
}

async function runOnce(deps: ProbeDeps, attempt: number): Promise<PromptDeliveryStatus> {
  const startedAt = Date.now();
  /* The L1 folder is a trusted, memory-free cwd (BUG-028 / BUG-031);
   * fall back to the data root when it has not been created yet. */
  const l1Dir = path.posix.join(DATA_ROOT, 'voice-l1');
  const cwd = fs.existsSync(l1Dir) ? l1Dir : DATA_ROOT;
  const promptFile = path.posix.join(DATA_ROOT, 'prompt-delivery-probe.txt');
  try {
    fs.writeFileSync(promptFile, PROBE_PROMPT, 'utf-8');
  } catch (err) {
    return {
      status: 'failed',
      checked_at: new Date().toISOString(),
      detail: `could not write probe prompt: ${(err as Error).message}`,
      elapsed_ms: Date.now() - startedAt,
    };
  }
  const args = probeArgs(promptFile);
  try {
    const { stdout, stderr, code } = await (deps.run ?? defaultRun)(
      args,
      cwd,
      probeEnv(process.env),
    );
    const reply = stdout.trim();
    const elapsed = Date.now() - startedAt;
    if (reply.includes(PROMPT_PROBE_MARKER)) {
      return {
        status: 'ok',
        checked_at: new Date().toISOString(),
        detail: `prompt file honoured (${args.find((a) => a.endsWith('-file')) ?? '?'}, attempt ${attempt})`,
        elapsed_ms: elapsed,
      };
    }
    return {
      status: 'failed',
      checked_at: new Date().toISOString(),
      detail: `reply lacked "${PROMPT_PROBE_MARKER}" (exit ${code ?? 'null'}, attempt ${attempt}): stdout=${JSON.stringify(reply.slice(0, 200))} stderr=${JSON.stringify(stderr.slice(-200))}`,
      elapsed_ms: elapsed,
    };
  } catch (err) {
    return {
      status: 'failed',
      checked_at: new Date().toISOString(),
      detail: `attempt ${attempt}: ${(err as Error).message}`,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

function report(deps: ProbeDeps, r: PromptDeliveryStatus): void {
  if (r.status === 'ok') {
    deps.log(`[prompt-probe] ok: Claude Code delivered the prompt file in ${r.elapsed_ms}ms`);
  } else if (r.status === 'failed') {
    deps.log(
      `[prompt-probe] FAILED: ${r.detail}. If this repeats, every Lex session boots without its identity and contract (BUG-041); check the L1 warm line for "contract confirmed".`,
    );
  }
}

/** Schedule the probe after the boot storm; one retry after a failure.
 * Resolves with the final status. Never throws, never blocks boot. */
export async function runPromptDeliveryProbe(deps: ProbeDeps): Promise<PromptDeliveryStatus> {
  if (
    process.env.VITEST ||
    process.env.CI === 'true' ||
    process.env.DEVNEURAL_PROMPT_PROBE === '0'
  ) {
    if (!deps.run) {
      current = {
        status: 'skipped',
        checked_at: new Date().toISOString(),
        detail: 'disabled (VITEST / CI / DEVNEURAL_PROMPT_PROBE=0)',
      };
      return current;
    }
  }
  const delay = deps.delay ?? defaultDelay;
  await delay(deps.delay ? 0 : PROBE_BOOT_DELAY_MS);
  let r = await runOnce(deps, 1);
  report(deps, r);
  current = r;
  if (r.status === 'failed') {
    await delay(deps.delay ? 0 : PROBE_RETRY_DELAY_MS);
    r = await runOnce(deps, 2);
    report(deps, r);
    current = r;
  }
  return current;
}
