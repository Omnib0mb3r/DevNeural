/**
 * Daemon-managed PTY host.
 *
 * Spawns a child process (typically `claude`) inside a real Windows
 * ConPTY so the daemon owns both ends of the terminal: it pumps stdout
 * into the existing terminal-stream ring (so the dashboard's terminal
 * mirror just works) and accepts stdin writes via /pty/:id/inject so
 * the dashboard can steer without involving VS Code or the bridge.
 *
 * Why this exists: VS Code's CLI is unreliable when invoked against an
 * already-running instance ("code <path>" sometimes IPCs without
 * actually opening a window) and even when it does, the bridge
 * extension lives inside VS Code which is the wrong place for an
 * always-on supervisor that must work from iPad over Tailscale.
 *
 * The daemon-PTY path is the canonical "Start Claude" surface. The
 * 09-bridge stays as an opt-in fallback for users who prefer their
 * Claude session living inside a VS Code terminal.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { pushTerminalData } from './terminal-stream.js';
import {
  registerBrainstorm,
  bindBrainstormSessionId,
  isBrainstormCwd,
  getBrainstormByPty,
  endBrainstorm,
} from '../lex/brainstorm-store.js';

interface PtyHandle {
  ptyId: string;
  /** Bound once we discover the session-id from claude's jsonl dir.
   * Mirror data is pushed into the terminal-stream ring under this id
   * so the existing /sessions/:id/terminal-* endpoints work. */
  sessionId: string | null;
  pty: IPty;
  cwd: string;
  command: string;
  startedAt: number;
  lastActivity: number;
  exited: boolean;
  /** Pre-binding buffer. We start receiving stdout before we know the
   * session-id. We accumulate up to ~256 KB of bytes so once we
   * discover the id we can flush them into the ring in order. */
  preBuffer: string[];
  preBufferBytes: number;
}

const ptys = new Map<string, PtyHandle>();
const sessionToPty = new Map<string, string>();
const PRE_BUFFER_MAX = 256 * 1024;

export interface SpawnLexOptions {
  cwd: string;
  /** Full command to run. Defaults to `claude`. We pass through to
   * node-pty as the executable + args. */
  command?: string;
  args?: string[];
  /** Lex-style append. The daemon writes the prompt to a temp file and
   * passes --append-system-prompt @<file> so very long prompts don't
   * blow the Windows command-line length limit. */
  systemPrompt?: string;
  cols?: number;
  rows?: number;
  /** Extra env vars merged onto process.env. */
  env?: Record<string, string>;
}

export interface SpawnLexResult {
  ptyId: string;
  pid: number;
}

function claudeProjectsRoot(): string {
  return path.posix.join(
    os.homedir().replace(/\\/g, '/'),
    '.claude',
    'projects',
  );
}

function cwdToClaudeSlug(cwd: string): string {
  /* Mirrors Claude Code's directory naming: replace : / \ with -.
   * Source: ~/.claude/projects/C--dev-Projects-DevNeural for cwd
   * "C:\dev\Projects\DevNeural". */
  return cwd.replace(/[\\/:]/g, '-');
}

function tryDiscoverSession(handle: PtyHandle): void {
  if (handle.sessionId) return;
  const slug = cwdToClaudeSlug(handle.cwd);
  const slugDir = path.posix.join(claudeProjectsRoot(), slug);
  if (!fs.existsSync(slugDir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(slugDir, { withFileTypes: true });
  } catch {
    return;
  }
  /* Pick the .jsonl created after we spawned (mtimeMs > startedAt
   * with a small slack for clock skew). claude creates the file once
   * the first turn writes; before that there's nothing here. */
  const fresh = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => {
      const file = path.posix.join(slugDir, e.name);
      try {
        const stat = fs.statSync(file);
        return { name: e.name, ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { name: string; ctimeMs: number; mtimeMs: number } => Boolean(x))
    .filter((x) => x.ctimeMs >= handle.startedAt - 2_000)
    .sort((a, b) => a.ctimeMs - b.ctimeMs);
  if (fresh.length === 0) return;
  const first = fresh[0]!;
  const sessionId = first.name.replace(/\.jsonl$/, '');
  handle.sessionId = sessionId;
  sessionToPty.set(sessionId, handle.ptyId);
  /* Flush pre-binding buffer into the ring. */
  if (handle.preBuffer.length > 0) {
    pushTerminalData(sessionId, handle.preBuffer.join(''));
    handle.preBuffer = [];
    handle.preBufferBytes = 0;
  }
  /* Patch the brainstorm_session record (if any) with the just-bound
   * claude session_id. Subsequent retrieval can join brainstorm_sessions
   * to raw_chunks_meta on session_id and surface "this is brainstorm
   * session named X" instead of orphan transcript chunks. */
  try {
    bindBrainstormSessionId(handle.ptyId, sessionId);
  } catch {
    /* ignore */
  }
}

/**
 * Spawn a `claude` (or any) PTY at the given cwd. The returned ptyId
 * lets the dashboard address the live PTY before claude has written
 * its session-id jsonl. Once that file appears, the PTY is bound to
 * the session-id and subsequent stdout flows into the standard
 * terminal-stream ring keyed by session-id.
 */
export function spawnLex(opts: SpawnLexOptions): SpawnLexResult {
  const cwd = opts.cwd.replace(/\\/g, '/');
  if (!fs.existsSync(cwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
  const ptyId = randomUUID();

  /* Materialise the system prompt to a temp file when present so the
   * value can be very long without bumping into Windows CMD's 8192-
   * char command-line limit. claude reads the file when given
   * --append-system-prompt @<path>. */
  let systemPromptFile: string | null = null;
  if (opts.systemPrompt) {
    const dir = path.posix.join(os.tmpdir().replace(/\\/g, '/'), 'devneural-lex');
    fs.mkdirSync(dir, { recursive: true });
    const hash = createHash('sha1')
      .update(opts.systemPrompt)
      .digest('hex')
      .slice(0, 12);
    systemPromptFile = path.posix.join(dir, `${hash}.txt`);
    if (!fs.existsSync(systemPromptFile)) {
      fs.writeFileSync(systemPromptFile, opts.systemPrompt, 'utf-8');
    }
  }

  const command = opts.command ?? 'claude';
  const args = [...(opts.args ?? [])];
  if (systemPromptFile) {
    args.push('--append-system-prompt', `@${systemPromptFile}`);
  }

  /* On Windows, node-pty needs a real executable path or a name
   * resolvable via cmd.exe. For .cmd shims (claude is one) we wrap
   * via cmd.exe /c so PATHEXT resolution kicks in, identical to the
   * shell:true reasoning in projects-new.ts. */
  const isWindows = process.platform === 'win32';
  const execPath = isWindows ? process.env.ComSpec ?? 'cmd.exe' : command;
  const execArgs = isWindows
    ? ['/d', '/s', '/c', [command, ...args].map(quoteWindowsArg).join(' ')]
    : args;

  const pty = ptySpawn(execPath, execArgs, {
    name: 'xterm-256color',
    cols: opts.cols ?? 200,
    rows: opts.rows ?? 64,
    cwd,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
  });

  const handle: PtyHandle = {
    ptyId,
    sessionId: null,
    pty,
    cwd,
    command: [command, ...args].join(' '),
    startedAt: Date.now(),
    lastActivity: Date.now(),
    exited: false,
    preBuffer: [],
    preBufferBytes: 0,
  };
  ptys.set(ptyId, handle);

  /* Register a first-class brainstorm_session record if this PTY's
   * cwd matches the brainstorm convention. Lex spawns get a record
   * the moment they start, with status=active and no claude_session_id
   * yet. Once the jsonl appears and we bind, we patch the record with
   * the claude_session_id so retrieval can join the two. */
  try {
    if (isBrainstormCwd(cwd)) {
      registerBrainstorm({
        ptyId,
        cwd,
        startedMs: handle.startedAt,
      });
    }
  } catch {
    /* brainstorm registration is observability, never block spawn */
  }

  pty.onData((data) => {
    handle.lastActivity = Date.now();
    /* If we've already bound, push directly into the ring. Otherwise
     * accumulate in the pre-buffer. We probe for the session-id every
     * chunk on the early side and every ~16 chunks once we've been
     * running a while, so a slow first turn doesn't keep us probing
     * the filesystem forever. */
    if (handle.sessionId) {
      pushTerminalData(handle.sessionId, data);
      return;
    }
    handle.preBuffer.push(data);
    handle.preBufferBytes += data.length;
    while (handle.preBufferBytes > PRE_BUFFER_MAX && handle.preBuffer.length > 1) {
      const head = handle.preBuffer.shift()!;
      handle.preBufferBytes -= head.length;
    }
    tryDiscoverSession(handle);
  });

  pty.onExit(({ exitCode }) => {
    handle.exited = true;
    if (handle.sessionId) {
      pushTerminalData(
        handle.sessionId,
        `\r\n[lex pty exited: code=${exitCode}]\r\n`,
      );
      sessionToPty.delete(handle.sessionId);
    }
    /* Mark the brainstorm row ended so /lex/sessions?status=active
     * stops returning rows for dead PTYs. Closes the Slice A leak
     * where killing a PTY left the row stuck at status='active'. */
    try {
      const bs = getBrainstormByPty(handle.ptyId);
      if (bs && bs.status === 'active') {
        endBrainstorm(bs.id);
      }
    } catch {
      /* observability: never block exit cleanup */
    }
    /* Keep the entry around briefly so the dashboard can read final
     * status; reaper sweeps it in 60s. */
    setTimeout(() => ptys.delete(ptyId), 60_000);
  });

  return { ptyId, pid: pty.pid };
}

function quoteWindowsArg(arg: string): string {
  /* cmd.exe needs different quoting than CreateProcess. We double-
   * quote anything containing whitespace, &, |, <, >, ^, or @. The
   * @ matters because we use --append-system-prompt @<path>. */
  if (!arg) return '""';
  if (!/[\s&|<>^"@]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function getPty(ptyId: string): PtyHandle | undefined {
  return ptys.get(ptyId);
}

export function getPtyBySession(sessionId: string): PtyHandle | undefined {
  const id = sessionToPty.get(sessionId);
  return id ? ptys.get(id) : undefined;
}

export function listPtys(): {
  ptyId: string;
  sessionId: string | null;
  cwd: string;
  command: string;
  startedAt: number;
  lastActivity: number;
  exited: boolean;
}[] {
  return [...ptys.values()].map((h) => ({
    ptyId: h.ptyId,
    sessionId: h.sessionId,
    cwd: h.cwd,
    command: h.command,
    startedAt: h.startedAt,
    lastActivity: h.lastActivity,
    exited: h.exited,
  }));
}

/**
 * Snapshot of a PTY's pre-binding output. Lets the dashboard render
 * something during the window between spawn and session-id discovery.
 * Once the session-id is bound the standard
 * /sessions/:id/terminal-replay handler is the canonical surface.
 */
export function getPtyOutput(ptyId: string): string {
  const h = ptys.get(ptyId);
  if (!h) return '';
  return h.preBuffer.join('');
}

/**
 * Write text to the PTY's stdin. With commit=true, append \r so claude
 * sees the line as committed (same as pressing Enter). commit=false
 * pastes without committing so the user can review/edit (parity with
 * the existing bridge "suggest" path).
 */
export function ptyInject(
  ptyIdOrSession: string,
  text: string,
  commit: boolean = true,
): { ok: true } | { ok: false; error: string } {
  let handle = ptys.get(ptyIdOrSession);
  if (!handle) handle = getPtyBySession(ptyIdOrSession);
  if (!handle) return { ok: false, error: 'pty not found' };
  if (handle.exited) return { ok: false, error: 'pty has exited' };
  try {
    handle.pty.write(text);
    if (commit) {
      /* Brief gap mirrors the bridge's 80ms paste-then-Enter delay so
       * bracketed-paste-mode terminators are fully delivered before
       * the carriage return commits. */
      setTimeout(() => {
        if (!handle!.exited) handle!.pty.write('\r');
      }, 80);
    }
    handle.lastActivity = Date.now();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function ptyResize(
  ptyIdOrSession: string,
  cols: number,
  rows: number,
): boolean {
  let handle = ptys.get(ptyIdOrSession);
  if (!handle) handle = getPtyBySession(ptyIdOrSession);
  if (!handle || handle.exited) return false;
  try {
    handle.pty.resize(cols, rows);
    return true;
  } catch {
    return false;
  }
}

export function ptyKill(ptyIdOrSession: string): boolean {
  let handle = ptys.get(ptyIdOrSession);
  if (!handle) handle = getPtyBySession(ptyIdOrSession);
  if (!handle) return false;
  try {
    handle.pty.kill();
    return true;
  } catch {
    return false;
  }
}

/**
 * Periodic background probe so a session-id that wasn't visible at
 * spawn (jsonl not yet created) gets bound as soon as claude writes
 * its first turn. Cheap: only probes PTYs that haven't bound yet.
 */
let probeTimer: ReturnType<typeof setInterval> | null = null;
export function startSessionDiscoveryProbe(): void {
  if (probeTimer) return;
  probeTimer = setInterval(() => {
    for (const handle of ptys.values()) {
      if (!handle.sessionId && !handle.exited) {
        tryDiscoverSession(handle);
      }
    }
  }, 1_000);
}
