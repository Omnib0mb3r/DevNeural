/* Shared headless Opus engine (sliver 2, 2026-06-19).
 *
 * One spawn primitive for every ephemeral investigator job: cold-start
 * priming, distillation, and (later) end-of-session handoff + crash
 * patching. Extracted from lex-investigator.ts so distill and cold-start
 * run on the SAME engine instead of two writers on two channels - the
 * unification the investigator pipeline spec calls for (Hole 4).
 *
 * BF-4 note: this is a `claude` subprocess on the user's own auth - the
 * same interactive channel Lex uses - NOT a daemon provider.call(), so
 * it is outside the outbound-guard that blocks brainstorm content from
 * automated off-host calls. Distillation may therefore run through here
 * even though the ollama provider path is BF-4-gated for the anthropic
 * provider.
 */
import { spawn } from 'node:child_process';

/** Run-a-headless-Opus-pass contract. Resolves the reply text, or null
 * on ANY failure so every caller can fall back deterministically. */
export type SpawnHeadlessOpus = (
  prompt: string,
  cwd: string,
  timeoutMs: number,
) => Promise<string | null>;

/* Prod headless Opus pass: `claude -p` reading the prompt from stdin
 * (avoids OS arg-length limits on a multi-KB context). Fail-safe by
 * contract - resolves null on ANY failure (missing binary, non-zero
 * exit, timeout, spawn error) so callers fall back to their
 * deterministic baseline. windowsHide keeps no console flashing;
 * shell:true lets the Windows `claude` .cmd shim resolve on PATH.
 *
 * NOT unit-tested (it spawns a real claude process); callers inject a
 * stub for their fallback-path tests. Validate live on the next daemon
 * restart. */
export function spawnHeadlessOpus(
  prompt: string,
  cwd: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'claude',
        ['-p', '--output-format', 'text', '--dangerously-skip-permissions'],
        {
          cwd,
          shell: process.platform === 'win32',
          windowsHide: true,
        },
      );
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
      /* Hard cap so a runaway reply can't balloon memory. */
      if (out.length > 200_000) {
        clearTimeout(timer);
        finish(out);
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      finish(code === 0 && out.trim() ? out : null);
    });
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}
