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
import { execSync } from 'node:child_process';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { pushTerminalData } from './terminal-stream.js';
import {
  registerBrainstorm,
  bindBrainstormSessionId,
  isBrainstormCwd,
  getBrainstormByPty,
  endBrainstorm,
  getStore as getBrainstormStore,
} from '../lex/brainstorm-store.js';
import { runSessionEndPipeline } from '../lex/session-end-pipeline.js';

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
  /** Live grid dims. The bridge endpoint always reports cols/rows when
   * pushing CC-bridge bytes, so the mirror's xterm can resize and the
   * source's ANSI cursor positioning lands on the right cells. Daemon-
   * spawned PTYs have to do the same or the brainstorm mirror stacks
   * status-bar redraws instead of overwriting them. */
  cols: number;
  rows: number;
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
    pushTerminalData(
      sessionId,
      handle.preBuffer.join(''),
      handle.cols,
      handle.rows,
    );
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
    /* Defaults sized to render legibly inside the dashboard's
     * TerminalMirror panel. The mirror predicts fontSize as
     * ~panelWidth/cols/0.6; at 200 cols the font collapses to ~5px
     * and ANSI cursor moves land off-grid, producing the "jumbled"
     * brainstorm mirror. 110×34 keeps font ~10-12px in a typical
     * panel and matches what real CC sessions emit when launched
     * from a normal terminal, so /lex and /sessions render the same. */
    cols: opts.cols ?? 110,
    rows: opts.rows ?? 34,
    cwd,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
  });

  const cols = opts.cols ?? 110;
  const rows = opts.rows ?? 34;
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
    cols,
    rows,
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
      pushTerminalData(handle.sessionId, data, handle.cols, handle.rows);
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
     * where killing a PTY left the row stuck at status='active'.
     * Also fires the session-end pipeline (force-flush wiki ingest,
     * refresh session summary, embed mode-tagged summary chunk into
     * raw_chunks) BEFORE the row is closed so subsequent retrieval
     * still has the active brainstorm row available for source-class
     * tier-up while the chunk is being written. Best-effort: errors
     * from the pipeline never block cleanup. */
    try {
      const bs = getBrainstormByPty(handle.ptyId);
      if (bs && bs.status === 'active') {
        void runSessionEndPipeline(
          getBrainstormStore(),
          {
            brainstormId: bs.id,
            claudeSessionId: bs.claude_session_id,
            mode: bs.mode,
            reason: 'pty-exit',
          },
          (msg) => console.log(msg),
        )
          .catch((err) =>
            console.log(
              `[pty-host] session-end pipeline failed: ${(err as Error).message}`,
            ),
          )
          .finally(() => {
            try {
              endBrainstorm(bs.id);
            } catch {
              /* observability: never block exit cleanup */
            }
          });
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

/**
 * Inject a `[seed]` first-turn prompt shortly after spawn so Lex greets
 * the user without waiting for typed input. The Lex system prompt has a
 * matching `[seed]` protocol that recognises this marker and produces a
 * brief Jarvis-voice greeting. 600ms gives Claude Code time to boot and
 * render its prompt before we paste; \r commits the turn the same way
 * `ptyInject(..., commit=true)` does.
 */
export function seedFirstTurn(ptyId: string): void {
  /* [seed] is a Lex system-prompt protocol marker; the prompt instructs
   * the assistant to treat a [seed] line as an autonomous first-turn
   * trigger and respond with a brief Jarvis-voice greeting.
   *
   * Readiness gate. Claude Code's TUI shows multiple cold-start
   * overlays (bypass-permissions warning, doctor advisory, the
   * "shift+tab to cycle" picker) that each absorb stray Enter
   * keypresses. A fixed delay isn't reliable: on a fast box the
   * overlays clear in ~500ms; on a slow one they hang around for
   * 6+ seconds. We use the SessionStart hook firing (which only
   * happens once CC's prompt is fully interactive) as the readiness
   * signal: handle.sessionId binds to the claude_session_id at that
   * moment. Poll every 500ms for up to 30s; if the bind never lands,
   * fall back to a best-effort write so the spawn isn't a total dud.
   *
   * Once ready: 250ms idle window + write seed + 250ms gap + \r commit.
   * The idle window lets any pending overlay-render bytes drain so our
   * text lands cleanly on the prompt line instead of mid-redraw. */
  const seedText =
    '[seed] Greet briefly in Jarvis voice. Ask what we are working on today. Reference live state if relevant.';
  const startedAt = Date.now();
  const READINESS_TIMEOUT_MS = 30_000;
  const POLL_MS = 500;
  const IDLE_MS = 250;

  /* Pre-dismiss the bypass-permissions / doctor banners that block the
   * SessionStart hook. CC's TUI shows these overlays on cold start with
   * --dangerously-skip-permissions and waits for an Enter key to
   * confirm; without dismissal the prompt never goes interactive,
   * SessionStart never fires, and the seed never runs. We send two \r
   * bytes spaced 600ms apart so any second-stage banner also clears. */
  setTimeout(() => {
    const handle = ptys.get(ptyId);
    if (!handle || handle.exited) return;
    try { handle.pty.write('\r'); } catch { /* swallow */ }
  }, 1500);
  setTimeout(() => {
    const handle = ptys.get(ptyId);
    if (!handle || handle.exited) return;
    try { handle.pty.write('\r'); } catch { /* swallow */ }
  }, 2100);

  function attemptWrite(handle: PtyHandle): void {
    try {
      /* Wait for an idle window after the last stdout chunk so we
       * don't paste mid-redraw. lastActivity advances on every onData
       * callback so a fresh chunk pushes the deadline forward. */
      const settle = () => {
        if (handle.exited) return;
        const sinceLast = Date.now() - handle.lastActivity;
        if (sinceLast < IDLE_MS) {
          setTimeout(settle, IDLE_MS - sinceLast);
          return;
        }
        try {
          handle.pty.write(seedText);
          setTimeout(() => {
            if (!handle.exited) handle.pty.write('\r');
          }, 250);
          handle.lastActivity = Date.now();
        } catch {
          /* best-effort; do not crash spawn */
        }
      };
      settle();
    } catch {
      /* swallow */
    }
  }

  function tick(): void {
    const handle = ptys.get(ptyId);
    if (!handle || handle.exited) return;
    if (handle.sessionId) {
      attemptWrite(handle);
      return;
    }
    /* Discovery is normally driven by pty.onData callbacks. A CC TUI
     * sitting silent on a banner emits no chunks, so onData never
     * fires and the session id never binds. Re-probe each tick so a
     * jsonl that lands during a quiet window is still picked up. */
    try { tryDiscoverSession(handle); } catch { /* ignore */ }
    if (handle.sessionId) {
      attemptWrite(handle);
      return;
    }
    if (Date.now() - startedAt > READINESS_TIMEOUT_MS) {
      /* Fallback so a session that never produces a SessionStart hook
       * (rare, e.g. CC build mismatch) still gets a seed try. */
      attemptWrite(handle);
      return;
    }
    setTimeout(tick, POLL_MS);
  }

  setTimeout(tick, POLL_MS);
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
    handle.cols = cols;
    handle.rows = rows;
    /* Push a zero-data refresh so the ring records the new dims and
     * fans an `s` envelope to live mirrors. Without this the mirror
     * keeps using the prior grid until the next stdout chunk arrives. */
    if (handle.sessionId) {
      pushTerminalData(handle.sessionId, '', cols, rows);
    }
    return true;
  } catch {
    return false;
  }
}

export function ptyKill(ptyIdOrSession: string): boolean {
  let handle = ptys.get(ptyIdOrSession);
  if (!handle) handle = getPtyBySession(ptyIdOrSession);
  if (!handle) {
    console.warn(`[pty-host] ptyKill: handle not found for ${ptyIdOrSession}`);
    return false;
  }
  const pid = handle.pty.pid;
  const ptyId = handle.ptyId;
  /* On Windows the PTY wraps cmd.exe /c "claude ..." (see spawnLex).
   * node-pty's kill() closes the ConPTY but the claude.exe grandchild
   * frequently survives, which means onExit never fires, handle.exited
   * stays false, and the dashboard's `!p.exited` filter keeps the
   * session alive forever. taskkill /F /T tears down the whole tree
   * by PID so the OS reaps every descendant and onExit fires reliably.
   * The pty.kill() is still attempted first so the SIGHUP-equivalent
   * gets a chance on non-Windows hosts. */
  let killed = false;
  try {
    handle.pty.kill();
    killed = true;
  } catch (err) {
    console.warn(
      `[pty-host] ptyKill: pty.kill() threw for ${ptyId} pid=${pid}: ${(err as Error).message}`,
    );
  }
  if (process.platform === 'win32' && pid && pid > 0) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, {
        stdio: 'ignore',
        windowsHide: true,
      });
      killed = true;
    } catch (err) {
      /* taskkill exits 128 when the PID is already gone, which is fine.
       * Anything else is a real failure worth logging. */
      const msg = (err as Error).message;
      if (!/not found|not running|128/i.test(msg)) {
        console.warn(
          `[pty-host] ptyKill: taskkill failed for ${ptyId} pid=${pid}: ${msg}`,
        );
      }
    }
  }
  /* Force the exited flag so the dashboard's filter drops the entry
   * even if node-pty's onExit handler lags or never fires. The reaper
   * still removes the map entry after 60s. */
  if (!handle.exited) {
    handle.exited = true;
    if (handle.sessionId) {
      sessionToPty.delete(handle.sessionId);
    }
    try {
      const bs = getBrainstormByPty(ptyId);
      if (bs && bs.status === 'active') {
        endBrainstorm(bs.id);
      }
    } catch {
      /* observability: never block kill */
    }
    setTimeout(() => ptys.delete(ptyId), 60_000);
  }
  console.log(
    `[pty-host] ptyKill: ${ptyId} pid=${pid} killed=${killed}`,
  );
  return killed;
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
