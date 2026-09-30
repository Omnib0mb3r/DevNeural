/**
 * Inject-delivery probe (BUG-059, 2026-09-30).
 *
 * The daemon talks to every Claude Code session by typing into its
 * terminal: text, then Enter. Claude Code changes how its input box
 * treats that underneath us. v2.1.277 started holding a fast burst that
 * carries its own Enter as a paste ("Removed 1 invisible character ·
 * review and press Enter to send"), and typed messages to Lex sat
 * unsubmitted until the operator noticed she had gone quiet.
 *
 * This probe makes that class of regression visible after boot. It
 * spawns one throwaway interactive haiku session exactly the way Layer 1
 * is spawned (spawnLex, no tools, no MCP, no user-scope settings), waits
 * for the input box, sends a long single-line message through the real
 * ptyInject, and checks that the model answered. The result lands in
 * daemon.log and in GET /health as `inject_delivery`.
 *
 * Costs one haiku call per daemon boot. Skipped under Vitest, CI, and
 * when DEVNEURAL_INJECT_PROBE=0.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_ROOT } from '../paths.js';
import { getPty, ptyInject, ptyKill, spawnLex } from '../dashboard/pty-host.js';

export const INJECT_PROBE_MARKER = 'INJECT OK';
const PROBE_PROMPT = `You are the DevNeural inject-delivery probe. Whatever the user says, reply with exactly: ${INJECT_PROBE_MARKER}`;
/* Long enough to trip Claude Code's paste handling the way a typed
 * operator message does (the held case was 118 chars), one line, and
 * free of the marker so an echo of the input can never pass. */
export const INJECT_PROBE_MESSAGE =
  'Delivery probe from the DevNeural daemon, sent the same way a typed operator message is sent: the text first, then Enter on its own. Nothing here needs any action. Answer with the one line your instructions give you.';
/* After the prompt probe (45 s) and the boot storm, so the two haiku
 * spawns never compete. */
export const INJECT_PROBE_BOOT_DELAY_MS = 120_000;
export const INJECT_PROBE_READY_TIMEOUT_MS = 90_000;
export const INJECT_PROBE_REPLY_TIMEOUT_MS = 90_000;
export const INJECT_PROBE_RETRY_DELAY_MS = 5 * 60_000;
/** Screen must be unchanged this long before the probe types. */
export const INJECT_PROBE_QUIET_MS = 2_000;
const POLL_MS = 500;

export type InjectDeliveryStatus =
  | { status: 'pending'; checked_at: null; detail: string }
  | { status: 'skipped'; checked_at: string; detail: string }
  | { status: 'ok'; checked_at: string; detail: string; elapsed_ms: number }
  | { status: 'failed'; checked_at: string; detail: string; elapsed_ms: number };

let current: InjectDeliveryStatus = {
  status: 'pending',
  checked_at: null,
  detail: 'probe not run yet',
};

export function getInjectDeliveryStatus(): InjectDeliveryStatus {
  return current;
}

/** Test seam. */
export function _resetInjectDeliveryForTests(): void {
  current = { status: 'pending', checked_at: null, detail: 'probe not run yet' };
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

/** What the terminal says after the inject. `held` is Claude Code
 * refusing to submit (the BUG-059 shape); `answered` is the model's
 * reply; `pending` is neither yet. Pure, exported for the pin. */
export function classifyProbeScreen(screen: string): 'answered' | 'held' | 'pending' {
  const s = stripAnsi(screen);
  if (s.includes(INJECT_PROBE_MARKER)) return 'answered';
  if (/Removed \d+ invisible character|press Enter to send/i.test(s)) return 'held';
  return 'pending';
}

/** Claude Code's input box has rendered. The prompt glyph is "❯" in a
 * UTF-8 console but a plain ">" under the daemon, and cursor moves can
 * swallow spaces, so key on the status line under the box ("shift+tab
 * to cycle", "? for shortcuts") as well as the glyph. Pure. */
export function isInputReady(screen: string): boolean {
  return /❯|shift\+tab|for\s*shortcuts/i.test(stripAnsi(screen));
}

export interface InjectProbeDeps {
  log: (msg: string) => void;
  /** Spawn the probe session; returns its pty id. */
  spawn?: () => { ptyId: string };
  /** Subscribe to the session's output. */
  onData?: (ptyId: string, cb: (d: string) => void) => void;
  inject?: (ptyId: string, text: string) => { ok: boolean; error?: string };
  kill?: (ptyId: string) => void;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultSpawn(): { ptyId: string } {
  const l1Dir = path.posix.join(DATA_ROOT, 'voice-l1');
  const cwd = fs.existsSync(l1Dir) ? l1Dir : DATA_ROOT;
  const r = spawnLex({
    cwd,
    systemPrompt: PROBE_PROMPT,
    systemPromptMode: 'replace',
    env: { MAX_THINKING_TOKENS: '0' },
    args: [
      '--session-id',
      randomUUID(),
      '--dangerously-skip-permissions',
      '--model',
      'haiku',
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      'project,local',
    ],
    skipLegacyBrainstormRegister: true,
  });
  return { ptyId: r.ptyId };
}

function defaultOnData(ptyId: string, cb: (d: string) => void): void {
  getPty(ptyId)?.pty.onData(cb);
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });
}

async function runOnce(deps: InjectProbeDeps, attempt: number): Promise<InjectDeliveryStatus> {
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? defaultDelay;
  const startedAt = now();
  const fail = (detail: string): InjectDeliveryStatus => ({
    status: 'failed',
    checked_at: new Date().toISOString(),
    detail: `attempt ${attempt}: ${detail}`,
    elapsed_ms: now() - startedAt,
  });
  let ptyId: string;
  try {
    ptyId = (deps.spawn ?? defaultSpawn)().ptyId;
  } catch (err) {
    return fail(`spawn failed: ${(err as Error).message}`);
  }
  let screen = '';
  (deps.onData ?? defaultOnData)(ptyId, (d) => {
    screen += d;
    if (screen.length > 200_000) screen = screen.slice(-100_000);
  });
  try {
    const readyBy = now() + INJECT_PROBE_READY_TIMEOUT_MS;
    while (!isInputReady(screen)) {
      if (now() > readyBy) {
        const tail = stripAnsi(screen).replace(/\s+/g, ' ').slice(-300);
        return fail(
          `input box never rendered (${screen.length} bytes of output); screen tail=${JSON.stringify(tail)}`,
        );
      }
      await delay(POLL_MS);
    }
    /* Type only once the screen has stopped changing, as a person
     * would. Text typed while Claude Code is still painting its startup
     * frames is buffered and delivered in one burst with the Enter,
     * which it holds as a paste (seen 2026-09-30 at +1.5 s). */
    let lastLen = -1;
    let quietSince = now();
    while (now() - quietSince < INJECT_PROBE_QUIET_MS) {
      if (now() > readyBy + INJECT_PROBE_READY_TIMEOUT_MS) {
        return fail('screen never settled after the input box rendered');
      }
      if (screen.length !== lastLen) {
        lastLen = screen.length;
        quietSince = now();
      }
      await delay(POLL_MS);
    }
    const sentAt = screen.length;
    const r = (deps.inject ?? ((id, t) => ptyInject(id, t, true)))(ptyId, INJECT_PROBE_MESSAGE);
    if (!r.ok) return fail(`inject refused: ${r.error ?? 'unknown'}`);
    const replyBy = now() + INJECT_PROBE_REPLY_TIMEOUT_MS;
    for (;;) {
      const verdict = classifyProbeScreen(screen.slice(sentAt));
      if (verdict === 'answered') {
        return {
          status: 'ok',
          checked_at: new Date().toISOString(),
          detail: `typed message submitted and answered (attempt ${attempt})`,
          elapsed_ms: now() - startedAt,
        };
      }
      if (verdict === 'held') {
        return fail(
          'Claude Code held the message unsubmitted ("press Enter to send"); every typed message and voice forward to a session will sit in its input box',
        );
      }
      if (now() > replyBy) {
        const tail = stripAnsi(screen).replace(/\s+/g, ' ').slice(-200);
        return fail(`no reply within ${INJECT_PROBE_REPLY_TIMEOUT_MS}ms; screen tail=${JSON.stringify(tail)}`);
      }
      await delay(POLL_MS);
    }
  } finally {
    try {
      (deps.kill ?? ((id) => void ptyKill(id)))(ptyId);
    } catch {
      /* already gone */
    }
  }
}

function report(deps: InjectProbeDeps, r: InjectDeliveryStatus): void {
  if (r.status === 'ok') {
    deps.log(`[inject-probe] ok: a typed message submitted and was answered in ${r.elapsed_ms}ms`);
  } else if (r.status === 'failed') {
    deps.log(
      `[inject-probe] FAILED: ${r.detail}. If this repeats, messages the daemon types into Claude Code sessions are not being submitted (BUG-059); check pty-host planPtyInjectWrites against the installed Claude Code.`,
    );
  }
}

/** Schedule the probe after the boot storm; one retry after a failure.
 * Resolves with the final status. Never throws, never blocks boot. */
export async function runInjectDeliveryProbe(deps: InjectProbeDeps): Promise<InjectDeliveryStatus> {
  if (
    (process.env.VITEST || process.env.CI === 'true' || process.env.DEVNEURAL_INJECT_PROBE === '0') &&
    !deps.spawn
  ) {
    current = {
      status: 'skipped',
      checked_at: new Date().toISOString(),
      detail: 'disabled (VITEST / CI / DEVNEURAL_INJECT_PROBE=0)',
    };
    return current;
  }
  const delay = deps.delay ?? defaultDelay;
  await delay(deps.delay ? 0 : INJECT_PROBE_BOOT_DELAY_MS);
  let r = await runOnce(deps, 1);
  report(deps, r);
  current = r;
  if (r.status === 'failed') {
    await delay(deps.delay ? 0 : INJECT_PROBE_RETRY_DELAY_MS);
    r = await runOnce(deps, 2);
    report(deps, r);
    current = r;
  }
  return current;
}
