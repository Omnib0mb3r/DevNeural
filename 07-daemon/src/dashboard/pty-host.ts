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
  bindBrainstormSessionId,
  isBrainstormCwd,
  getBrainstormByPty,
  endBrainstorm,
  getStore as getBrainstormStore,
  registerBrainstorm,
  reapOrphansAgainstLivePtys,
  getBrainstorm,
  detachWorkerSession,
} from '../lex/brainstorm-store.js';
import {
  setLexSessionStatus,
  closeTranscriptRef,
} from '../lex/lex-session-store.js';
import { runSessionEndPipeline } from '../lex/session-end-pipeline.js';

interface PtyHandle {
  ptyId: string;
  /** Brainstorm row uuid this PTY is bound to. Set at spawn time
   * (either passed in by the caller for a switch-to flow, or freshly
   * minted by spawn-lex when no row id was provided). The bind +
   * exit handlers use this to update the right row regardless of
   * what claude_session_id eventually appears in the jsonl. */
  brainstormId: string | null;
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
  /** Wave 3 fixup (bug: 2026-05-10-cc-feedback-prompt-unanswerable).
   * Set when claude code renders a native rating / y-n / continue
   * prompt in the PTY (detected by stdout pattern). While set, voice
   * WS injection refuses to forward transcribed text so the user does
   * not accidentally answer the prompt with "1" / "yes" via voice.
   * Cleared automatically 90s after the last pattern hit; sequential
   * matches keep it alive. */
  awaitingSystemPromptUntil: number;
  /** Last time we auto-wrote '0\r' to dismiss a CC native rating /
   * y-n / continue prompt. Used to cooldown the auto-dismiss so a
   * stream of redraw chunks doesn't spam multiple dismissal
   * keystrokes within the same prompt window. Bound to PtyHandle
   * because daemon-owned PTYs are headless: the Lex brainstorm
   * session has no human at the keyboard to press 0 manually, so
   * an undismissed prompt would block the session indefinitely.
   * Bridge-tracked sessions never reach this path (they flow
   * through worker-event-listener, not pty.onData), so this only
   * ever affects daemon-owned spawns. */
  lastSystemPromptDismissAt: number;
  /* Diagnostic fields stamped on exit / inject failure so the
   * dashboard TerminalMirror can render a small expandable error
   * block instead of leaving the user blind. lastCommandSent holds
   * the most recent text injected via ptyInject (truncated). exit*
   * fields are populated by the onExit handler. lastError is set
   * when an inject or spawn throws. */
  lastCommandSent: string | null;
  lastCommandAt: number;
  exitCode: number | null;
  exitSignal: number | null;
  exitedAt: number;
  lastError: string | null;
  /** Constructor / .name of the Error thrown on the last inject or
   * spawn failure. Carried alongside lastError so the diagnostic
   * panel can distinguish e.g. a node-pty "process has exited" from a
   * generic Error from a TypeError. Always null for normal-exit
   * paths; populated only when an exception was actually caught. */
  lastErrorClass: string | null;
}

/* Regexes that identify a CC native feedback / prompt overlay in the
 * stdout stream. The phrase regex alone is not enough: Lex renders his
 * own reply text back into the PTY, and ordinary prose like "I can
 * rate this session" or "press enter to continue" tripped the latch,
 * holding voice inject closed for 90s and silencing Lex on every turn
 * after the first. CC's native prompts always render inside a
 * box-drawing UI (╭─╮ │ ╰─╯, U+2500..U+257F); Lex prose never does.
 * Require BOTH a phrase hit AND a box-drawing char in the same chunk
 * before stamping the gate. */
const CC_SYSTEM_PROMPT_RE = new RegExp(
  [
    'How would you rate',
    'How is Claude doing this session',
    '1 = thumbs down',
    '0: Dismiss',
    'Rate this interaction',
    'rate this session',
    'Continue\\? \\(y/n\\)',
  ].join('|'),
  'i',
);
const CC_BOX_CHARS_RE = /[\u2500-\u257F]/;
/* Hold drops from 90s to 30s. The earlier value covered worst-case
 * prompt-scroll-off-screen scenarios, but combined with the now-strict
 * box-drawing requirement the false-positive risk is gone, so the
 * window can shrink. If a real prompt sits open longer than 30s the
 * next stdout chunk that still contains the prompt re-stamps it. */
const SYSTEM_PROMPT_HOLD_MS = 30_000;

export function isCcSystemPromptChunk(data: string): boolean {
  return CC_SYSTEM_PROMPT_RE.test(data) && CC_BOX_CHARS_RE.test(data);
}

/* Auto-dismiss cooldown. CC's feedback overlay redraws several times
 * across a single prompt session (cursor blink, terminal resize,
 * border re-render). Without a cooldown, every redraw chunk that
 * still matches the regex would trigger another '0\r' write, which
 * is at best wasted bytes and at worst could land on whatever
 * follow-up surface CC renders right after dismissal. 5s is long
 * enough to cover the redraw burst but short enough that a fresh
 * prompt opening 30s later (after the awaiting window expires) gets
 * its own dismiss. */
export const CC_SYSTEM_PROMPT_DISMISS_COOLDOWN_MS = 5_000;

/* Pure decision helper: should we auto-write '0\r' to dismiss the
 * CC native system prompt right now? Returns true only when the
 * chunk matches isCcSystemPromptChunk AND we have not auto-
 * dismissed within the cooldown window. Pulled out so the test
 * suite can pin every branch without spinning a real PTY. */
export function shouldAutoDismissSystemPrompt(
  data: string,
  lastDismissAt: number,
  now: number,
  cooldownMs: number = CC_SYSTEM_PROMPT_DISMISS_COOLDOWN_MS,
): boolean {
  if (!isCcSystemPromptChunk(data)) return false;
  if (now - lastDismissAt < cooldownMs) return false;
  return true;
}

/* Test-only re-exports for tests/cc-feedback-prompt-detect.test.ts.
 * Underscored to discourage runtime use. */
export const __CC_SYSTEM_PROMPT_RE_FOR_TEST = CC_SYSTEM_PROMPT_RE;
export const __CC_BOX_CHARS_RE_FOR_TEST = CC_BOX_CHARS_RE;
export const __SYSTEM_PROMPT_HOLD_MS_FOR_TEST = SYSTEM_PROMPT_HOLD_MS;

const ptys = new Map<string, PtyHandle>();
const sessionToPty = new Map<string, string>();
const PRE_BUFFER_MAX = 256 * 1024;

/* Live PTY id snapshot for the continuous brainstorm reaper. Returns
 * the set of pty_ids that are currently registered AND not yet
 * exited. The reaper compares this against status='active' brainstorm
 * rows and ends any whose PTY isn't in here, so a daemon SIGKILL or
 * any other path that bypasses the onExit handler doesn't leave a
 * phantom active row in the past-sessions list forever. */
export function getLivePtyIds(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const handle of ptys.values()) {
    if (!handle.exited) out.add(handle.ptyId);
  }
  return out;
}

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
  /** Brainstorm row uuid (which since the lex_session rewrite is
   * also the lex_session uuid; same value, write-through into both
   * tables). spawn-lex-session.ts always passes this so the PTY's
   * onExit handler can flip the right anchor dormant. */
  brainstormId?: string;
  /** When true, pty-host skips the legacy brainstorm_sessions
   * registration / rebind block. spawnLexSession sets this so the
   * legacy table is only ever written through the lex_session
   * code path (single source of truth for new spawns). */
  skipLegacyBrainstormRegister?: boolean;
}

export interface SpawnLexResult {
  ptyId: string;
  pid: number;
  /** The brainstorm row uuid this PTY is bound to. Either the value
   * passed in via opts.brainstormId, or the freshly-minted row id
   * for a fresh start. Always present for brainstorm-cwd spawns. */
  brainstormId: string | null;
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
  /* Stamp the discovered claude_session_id onto both the legacy
   * brainstorm_sessions row and the lex_session row this PTY was
   * bound to at spawn time. The row id is the canonical identity;
   * the claude_session_id is a mutable pointer. If a --resume was
   * rejected by the CLI and a new id was minted, this call repoints
   * the existing rows at the new id instead of forking a duplicate.
   * The lex_session model also tracks the cc_session_id per-spawn
   * via lex_transcript_ref, which spawn-lex-session.ts already
   * inserted; this is just the legacy mirror. */
  try {
    if (handle.brainstormId) {
      bindBrainstormSessionId(handle.brainstormId, handle.ptyId, sessionId);
    }
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
    brainstormId: null,
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
    awaitingSystemPromptUntil: 0,
    lastSystemPromptDismissAt: 0,
    lastCommandSent: null,
    lastCommandAt: 0,
    exitCode: null,
    exitSignal: null,
    exitedAt: 0,
    lastError: null,
    lastErrorClass: null,
  };
  ptys.set(ptyId, handle);

  /* Stamp the brainstorm/lex_session id on the handle so the
   * onExit handler can flip the right anchor dormant. New spawns
   * go exclusively through spawn-lex-session.ts which mints the
   * lex_session row + the write-through brainstorm_sessions row
   * before calling us; the legacy in-line registration block has
   * been retired. */
  if (opts.brainstormId) {
    handle.brainstormId = opts.brainstormId;
  } else if (isBrainstormCwd(cwd) && !opts.skipLegacyBrainstormRegister) {
    /* Backstop for any external caller (replay-pty harness, ad-hoc
     * /pty/spawn-lex POST during transition) that did not route
     * through spawn-lex-session.ts. Same legacy behaviour as
     * before: mint a brainstorm_sessions row and stamp its id on
     * the handle so onExit closes it. */
    try {
      const fresh = registerBrainstorm({
        ptyId,
        cwd,
        startedMs: handle.startedAt,
      });
      handle.brainstormId = fresh.id;
    } catch {
      /* observability only; never block spawn */
    }
  }

  pty.onData((data) => {
    handle.lastActivity = Date.now();
    /* Wave 3 fixup (bug: 2026-05-10-cc-feedback-prompt-unanswerable).
     * Stamp the awaiting-system-prompt window only when the chunk
     * contains BOTH a known CC prompt phrase AND a box-drawing char.
     * Phrase-alone matched Lex's own reply text rendering back into
     * the PTY ("rate this session", "continue?") and silenced him on
     * every turn after the first. */
    if (isCcSystemPromptChunk(data)) {
      handle.awaitingSystemPromptUntil = Date.now() + SYSTEM_PROMPT_HOLD_MS;
      /* Auto-dismiss for worker daemon-owned PTYs only. The Lex
       * brainstorm PTY (handle.brainstormId !== null) renders user
       * messages back into its own terminal stream — including
       * pasted screenshot text the operator hands to Lex via a
       * Read tool call. A screenshot of another worker's CC
       * feedback overlay contains the same phrase + box-drawing
       * chars the auto-dismiss matcher locks on, so the dismiss
       * fired into the Lex PTY and the resulting '0\r' submitted
       * a user turn that derailed Lex. The CC feedback overlay
       * never legitimately appears inside a Lex brainstorm
       * session (Lex is the operator-facing wrapper, not a worker
       * eligible to rate sessions), so gating on brainstormId
       * has no downside on the Lex side.
       *
       * Bridge-tracked external CC windows still flow through
       * worker-event-listener and never reach this callback;
       * fixing the bridge-attached auto-dismiss path is tracked
       * separately (2026-05-16-feedback-auto-dismiss-misses-
       * bridge-sessions.md). The cooldown via
       * lastSystemPromptDismissAt makes sure a redraw burst
       * within the same prompt window only writes '0\r' once. The
       * 80ms paste-then-Enter delay mirrors ptyInject so
       * bracketed-paste mode terminators are flushed before the
       * carriage return commits the dismissal. */
      const now = Date.now();
      if (
        handle.brainstormId === null &&
        shouldAutoDismissSystemPrompt(data, handle.lastSystemPromptDismissAt, now)
      ) {
        handle.lastSystemPromptDismissAt = now;
        try {
          handle.pty.write('0');
          setTimeout(() => {
            if (!handle.exited) {
              try { handle.pty.write('\r'); } catch { /* swallow */ }
            }
          }, 80);
          console.log(
            `[pty-host] auto-dismissed CC native prompt pty=${handle.ptyId} session=${handle.sessionId ?? '-'}`,
          );
        } catch {
          /* observability only; never crash the data handler */
        }
      }
    }
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

  pty.onExit((event) => {
    const exitCode = event?.exitCode ?? null;
    const signal =
      typeof (event as { signal?: number })?.signal === "number"
        ? (event as { signal?: number }).signal!
        : null;
    handle.exited = true;
    handle.exitCode = exitCode;
    handle.exitSignal = signal;
    handle.exitedAt = Date.now();
    /* Tail bytes from the pre-binding buffer act as a stderr/stdout
     * surrogate: PTYs merge both streams so the trailing data is the
     * last thing the process printed before exiting. Cap at 4 KB so
     * the diagnostic stays readable. */
    const tail = handle.preBuffer.join("").slice(-4096);
    const errSummary =
      exitCode !== 0 || signal !== null
        ? `exit_code=${exitCode ?? "?"} signal=${signal ?? "-"}`
        : null;
    if (errSummary) {
      handle.lastError = errSummary;
    }
    /* Explicit, structured log line so daemon.log carries the full
     * diagnostic. Without this, a non-zero exit (or a kill-9 from the
     * panic path) left no breadcrumb anywhere. */
    console.log(
      `[pty-host] exit pty=${handle.ptyId} session=${
        handle.sessionId ?? "-"
      } code=${exitCode ?? "?"} signal=${
        signal ?? "-"
      } last_command=${JSON.stringify(
        (handle.lastCommandSent ?? "").slice(0, 200),
      )} tail=${JSON.stringify(tail.slice(-512))}`,
    );
    if (handle.sessionId) {
      pushTerminalData(
        handle.sessionId,
        `\r\n[lex pty exited: code=${exitCode} signal=${signal ?? "-"}]\r\n`,
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
      /* Resolve via handle.brainstormId (stable PTY-lifetime identity)
       * with a getBrainstormByPty fallback for any legacy PTY that
       * pre-dates the brainstormId stamp. */
      const bs = handle.brainstormId
        ? getBrainstorm(handle.brainstormId)
        : getBrainstormByPty(handle.ptyId);
      /* Brainstorm-as-durable-primary-entity (2026-05-22): direct-
       * llm brainstorms have no Lex PTY backing them; a PTY exit on
       * the daemon NEVER corresponds to "Lex stopped". Only fire the
       * session-end pipeline when runtime_mode is cc-pty (legacy) or
       * unset (pre-migration rows default to cc-pty via SQLite). */
      const runtimeMode = bs?.runtime_mode ?? 'cc-pty';
      if (bs && bs.status === 'active' && runtimeMode === 'cc-pty') {
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
    /* Sync the lex_session model on exit too: flip the anchor
     * dormant + clear current_pty_id, and close the live transcript
     * ref by cc_session_id. Codex flagged that without these, a
     * natural PTY exit (or daemon crash) left lex_session.status
     * = 'live' even after the underlying process was gone, which
     * caused /lex/anchor-tiles to surface ghost tiles on the deck. */
    try {
      if (handle.brainstormId) {
        setLexSessionStatus(handle.brainstormId, {
          status: 'dormant',
          currentPtyId: null,
        });
      }
      if (handle.sessionId) {
        closeTranscriptRef(handle.sessionId);
      }
      /* Brainstorm-as-durable-primary-entity (2026-05-22): when a
       * worker CC session exits, detach it from any brainstorm that
       * had bound it via attachWorkerSession. The brainstorm itself
       * stays alive (the durable brain); only the worker tool went
       * away. */
      if (handle.sessionId) {
        try {
          const owning = getBrainstormStore().db.getBrainstormByAttachedWorker(
            handle.sessionId,
          );
          if (owning) {
            detachWorkerSession(owning.id);
          }
        } catch {
          /* observability only */
        }
      }
    } catch {
      /* observability only */
    }
    /* Keep the entry around briefly so the dashboard can read final
     * status; reaper sweeps it in 60s. */
    setTimeout(() => ptys.delete(ptyId), 60_000);
  });

  return { ptyId, pid: pty.pid, brainstormId: handle.brainstormId };
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
  /* Diagnostic surface. Populated on inject error / exit so the
   * TerminalMirror can render an expandable error block instead of
   * leaving the user blind. exit_code is null while the PTY is
   * alive; lastCommandSent carries a truncated copy of the most
   * recent inject. tail is the trailing 1 KB of the PTY's pre-
   * buffer (PTYs merge stdout+stderr so this is the last thing the
   * process actually printed). */
  exit_code: number | null;
  exit_signal: number | null;
  exited_at: number | null;
  last_error: string | null;
  last_error_class: string | null;
  last_command: string | null;
  last_command_at: number | null;
  output_tail: string;
}[] {
  return [...ptys.values()].map((h) => ({
    ptyId: h.ptyId,
    sessionId: h.sessionId,
    cwd: h.cwd,
    command: h.command,
    startedAt: h.startedAt,
    lastActivity: h.lastActivity,
    exited: h.exited,
    exit_code: h.exitCode,
    exit_signal: h.exitSignal,
    exited_at: h.exitedAt > 0 ? h.exitedAt : null,
    last_error: h.lastError,
    last_error_class: h.lastErrorClass,
    last_command: h.lastCommandSent ? h.lastCommandSent.slice(0, 200) : null,
    last_command_at: h.lastCommandAt > 0 ? h.lastCommandAt : null,
    output_tail: h.preBuffer.join("").slice(-1024),
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
 * Wave 3 fixup (bug: 2026-05-10-cc-feedback-prompt-unanswerable).
 * Report whether a PTY is currently rendering a CC native system
 * prompt (rating, y/n, continue?). Callers that auto-inject text on
 * the user's behalf (voice WS) should refuse to forward when this is
 * true so the user does not accidentally answer the system prompt
 * with their voice utterance. Typed-text paths are intentionally
 * unrestricted because the user can see the prompt and chooses.
 */
export function isAwaitingSystemPrompt(ptyIdOrSession: string): boolean {
  let handle = ptys.get(ptyIdOrSession);
  if (!handle) handle = getPtyBySession(ptyIdOrSession);
  if (!handle) return false;
  return Date.now() < handle.awaitingSystemPromptUntil;
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
    handle.lastCommandSent = text.slice(0, 4096);
    handle.lastCommandAt = Date.now();
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
    const e = err as Error;
    const message = e.message;
    const klass = e.name ?? 'Error';
    handle.lastError = message;
    handle.lastErrorClass = klass;
    console.log(
      `[pty-host] inject error pty=${handle.ptyId} session=${
        handle.sessionId ?? "-"
      } class=${klass} error=${JSON.stringify(message)} last_command=${JSON.stringify(
        text.slice(0, 200),
      )}`,
    );
    return { ok: false, error: message };
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
