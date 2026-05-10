/**
 * Wave 2 carry-over #4 (spec section 11 day 5 step 21): hermetic
 * Claude Code PTY runner for the A/B replay harness.
 *
 * One PTY per prompt version. Each version sees the same multi-turn
 * fixture in order; the PTYs do NOT share session state so the diff
 * isolates the system-prompt variable.
 *
 * Wire-up:
 *   1. mkdtemp a cwd OUTSIDE <dataRoot>/brainstorm so spawnLex skips
 *      registerBrainstorm (no production rows created).
 *   2. spawnLex({systemPrompt: promptText, args: ['--dangerously-skip-permissions']})
 *      writes the system-prompt to a temp file and starts claude.
 *   3. Poll ~/.claude/projects/<slug>/ for the freshly-created
 *      <session-id>.jsonl. claude does not create this file until the
 *      first turn writes, so we inject a seed turn before discovery
 *      kicks in.
 *   4. For each user input, write to PTY stdin (\r-committed) and tail
 *      the jsonl for the next assistant record with stop_reason='end_turn'.
 *      Capture text content blocks joined by \n.
 *   5. ptyKill + rm -rf cwd at the end (cleanup is best-effort; a
 *      crashed claude leaves the slug dir around but does not block
 *      future runs).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnLex, ptyInject, ptyKill, getPty } from '../dashboard/pty-host.js';

export interface HermeticTurnResult {
  text: string;
  ms: number;
  error?: string;
}

export interface HermeticRunOptions {
  /** Per-turn ceiling. Default 90s; covers a slow first-turn cold
   * start while keeping a stuck PTY from blocking the run forever. */
  turnTimeoutMs?: number;
  /** Discovery ceiling for the initial sessionId binding. Default
   * 20s; matches the slowest cold-start window observed in
   * production. */
  discoveryTimeoutMs?: number;
  log?: (m: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function claudeProjectsRoot(): string {
  return path.posix.join(
    os.homedir().replace(/\\/g, '/'),
    '.claude',
    'projects',
  );
}

function cwdToClaudeSlug(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-');
}

function readJsonlLines(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const out: Array<Record<string, unknown>> = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        /* ignore malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function extractAssistantText(rec: Record<string, unknown>): string | null {
  if (rec.type !== 'assistant') return null;
  const message = rec.message as
    | {
        content?: Array<{ type?: string; text?: string }>;
        stop_reason?: string;
      }
    | undefined;
  if (!message) return null;
  if (message.stop_reason !== 'end_turn') return null;
  const texts: string[] = [];
  for (const c of message.content ?? []) {
    if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
  }
  const text = texts.join('\n').trim();
  return text || null;
}

/* Walk the slug directory for any .jsonl file created since `since`
 * (with a small clock-skew slack). claude only writes its session file
 * after the first turn lands, so this polls until the spawn's first
 * inject has produced a record. */
function findFreshSessionFile(slugDir: string, since: number): string | null {
  if (!fs.existsSync(slugDir)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(slugDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => {
      const file = path.posix.join(slugDir, e.name);
      try {
        const stat = fs.statSync(file);
        return { file, ctimeMs: stat.ctimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { file: string; ctimeMs: number } => Boolean(x))
    .filter((x) => x.ctimeMs >= since - 2_000)
    .sort((a, b) => a.ctimeMs - b.ctimeMs);
  return candidates[0]?.file ?? null;
}

/* Block until the per-version PTY has a jsonl file we can tail.
 * Returns null on timeout. */
async function awaitSessionFile(
  cwd: string,
  startedAt: number,
  timeoutMs: number,
): Promise<string | null> {
  const slugDir = path.posix.join(claudeProjectsRoot(), cwdToClaudeSlug(cwd));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const file = findFreshSessionFile(slugDir, startedAt);
    if (file) return file;
    await sleep(250);
  }
  return null;
}

/* Inject one user turn, then poll the jsonl for the next assistant
 * end_turn record after the baseline line count. */
async function awaitTurn(
  jsonlPath: string,
  baselineLines: number,
  timeoutMs: number,
): Promise<{ text: string } | { error: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = readJsonlLines(jsonlPath);
    for (let i = baselineLines; i < lines.length; i++) {
      const rec = lines[i];
      if (!rec) continue;
      const text = extractAssistantText(rec);
      if (text !== null) return { text };
    }
    await sleep(300);
  }
  return { error: `timed out after ${timeoutMs}ms waiting for end_turn` };
}

export async function runHermeticVersion(
  promptText: string,
  inputs: string[],
  opts: HermeticRunOptions = {},
): Promise<HermeticTurnResult[]> {
  const log = opts.log ?? (() => undefined);
  const turnTimeoutMs = opts.turnTimeoutMs ?? 90_000;
  const discoveryTimeoutMs = opts.discoveryTimeoutMs ?? 20_000;
  /* Hermetic cwd OUTSIDE the brainstorm tree. pty-host gates
   * brainstorm row creation on isBrainstormCwd; sitting under tmpdir
   * keeps production state untouched. */
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-lex-replay-'));
  const startedAt = Date.now();
  const spawn = spawnLex({
    cwd: cwd.replace(/\\/g, '/'),
    systemPrompt: promptText,
    args: ['--dangerously-skip-permissions'],
  });
  log(`[lex-replay-pty] spawned ptyId=${spawn.ptyId} pid=${spawn.pid} cwd=${cwd}`);

  const results: HermeticTurnResult[] = [];
  let jsonlPath: string | null = null;

  for (let i = 0; i < inputs.length; i++) {
    const user = inputs[i]!;
    const t0 = Date.now();
    /* Inject first; the first inject is what causes claude to write
     * its session file. Subsequent injects flow into the same file. */
    const inj = ptyInject(spawn.ptyId, user, true);
    if (!inj.ok) {
      results.push({ text: '', ms: Date.now() - t0, error: inj.error });
      continue;
    }
    /* Discover the jsonl file lazily on the first turn so we don't
     * race claude's startup probe. Subsequent turns reuse the path. */
    if (!jsonlPath) {
      jsonlPath = await awaitSessionFile(cwd, startedAt, discoveryTimeoutMs);
      if (!jsonlPath) {
        results.push({
          text: '',
          ms: Date.now() - t0,
          error: 'session file never appeared',
        });
        break;
      }
    }
    const baseline = readJsonlLines(jsonlPath).length;
    /* Baseline taken AFTER inject so we look strictly for records that
     * postdate the new turn. claude's first inject usually shows up in
     * the jsonl synchronously; baseline includes that user line. */
    const turn = await awaitTurn(jsonlPath, baseline, turnTimeoutMs);
    if ('error' in turn) {
      results.push({ text: '', ms: Date.now() - t0, error: turn.error });
    } else {
      results.push({ text: turn.text, ms: Date.now() - t0 });
    }
  }

  /* Cleanup: kill the PTY first (taskkill /F /T on Windows reaps the
   * grandchild claude.exe), then remove the cwd. Both best-effort;
   * leftovers under tmpdir are harmless. */
  try {
    ptyKill(spawn.ptyId);
  } catch (err) {
    log(`[lex-replay-pty] ptyKill failed: ${(err as Error).message}`);
  }
  /* Brief wait so the file handles drop before rm -rf walks the dir. */
  await sleep(250);
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch (err) {
    log(`[lex-replay-pty] cleanup failed: ${(err as Error).message}`);
  }
  /* Sanity check we didn't leak the handle. getPty returns undefined
   * once the reaper sweeps; warm path returns the exited handle. */
  const remaining = getPty(spawn.ptyId);
  if (remaining && !remaining.exited) {
    log(`[lex-replay-pty] WARNING ptyId=${spawn.ptyId} still alive after kill`);
  }
  return results;
}
