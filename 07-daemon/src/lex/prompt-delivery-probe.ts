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
 * This probe makes that class of regression visible within a minute of
 * boot. It writes a one-line prompt file that says "reply with exactly
 * LEX READY", runs one throwaway `claude -p` with the same flag the
 * sessions use (--system-prompt-file), and checks the reply. The result
 * lands in daemon.log and in GET /health as `prompt_delivery`.
 *
 * Costs one haiku call per daemon boot. Skipped under Vitest, CI, and
 * when DEVNEURAL_PROMPT_PROBE=0.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_ROOT } from '../paths.js';
import { systemPromptArgs } from '../dashboard/pty-host.js';

export const PROMPT_PROBE_MARKER = 'LEX READY';
const PROBE_PROMPT =
  'You are the DevNeural prompt-delivery probe. Whatever the user says, reply with exactly: LEX READY';
const PROBE_TIMEOUT_MS = 120_000;

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

interface ProbeDeps {
  log: (msg: string) => void;
  /** Override the spawn for tests. Resolves with the child's stdout. */
  run?: (args: string[], cwd: string) => Promise<{ stdout: string; code: number | null }>;
}

function defaultRun(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    /* `claude` is a .cmd shim on Windows; run it through cmd.exe so
     * PATHEXT resolution applies, same as pty-host's spawnLex. */
    const exe = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'claude';
    const spawnArgs = isWindows
      ? ['/d', '/s', '/c', ['claude', ...args].map(quoteWindowsArg).join(' ')]
      : args;
    const child = spawn(exe, spawnArgs, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
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
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout || stderr, code });
    });
  });
}

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
  const startedAt = Date.now();
  /* The L1 folder is a trusted, memory-free cwd (BUG-028 / BUG-031);
   * fall back to the data root when it has not been created yet. */
  const l1Dir = path.posix.join(DATA_ROOT, 'voice-l1');
  const cwd = fs.existsSync(l1Dir) ? l1Dir : DATA_ROOT;
  const promptFile = path.posix.join(DATA_ROOT, 'prompt-delivery-probe.txt');
  try {
    fs.writeFileSync(promptFile, PROBE_PROMPT, 'utf-8');
  } catch (err) {
    current = {
      status: 'failed',
      checked_at: new Date().toISOString(),
      detail: `could not write probe prompt: ${(err as Error).message}`,
      elapsed_ms: Date.now() - startedAt,
    };
    deps.log(`[prompt-probe] FAILED: ${current.detail}`);
    return current;
  }
  const args = [
    '-p',
    '--model',
    'haiku',
    '--tools',
    '',
    ...systemPromptArgs('replace', promptFile),
    'Warmup check.',
  ];
  try {
    const { stdout, code } = await (deps.run ?? defaultRun)(args, cwd);
    const reply = stdout.trim();
    const elapsed = Date.now() - startedAt;
    if (reply.includes(PROMPT_PROBE_MARKER)) {
      current = {
        status: 'ok',
        checked_at: new Date().toISOString(),
        detail: `prompt file honoured (${systemPromptArgs('replace', promptFile)[0]})`,
        elapsed_ms: elapsed,
      };
      deps.log(`[prompt-probe] ok: Claude Code delivered the prompt file in ${elapsed}ms`);
    } else {
      current = {
        status: 'failed',
        checked_at: new Date().toISOString(),
        detail: `reply lacked "${PROMPT_PROBE_MARKER}" (exit ${code ?? 'null'}): ${JSON.stringify(reply.slice(0, 200))}`,
        elapsed_ms: elapsed,
      };
      deps.log(
        `[prompt-probe] FAILED: Claude Code did NOT deliver the prompt file; every Lex session will boot without its identity and contract (BUG-041). ${current.detail}`,
      );
    }
  } catch (err) {
    current = {
      status: 'failed',
      checked_at: new Date().toISOString(),
      detail: (err as Error).message,
      elapsed_ms: Date.now() - startedAt,
    };
    deps.log(`[prompt-probe] FAILED: ${current.detail}`);
  }
  return current;
}
