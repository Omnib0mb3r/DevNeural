/**
 * DevNeural Session Bridge.
 *
 * Watches c:/dev/data/skill-connections/session-bridge/<session-id>.in
 * for messages from the daemon. Each message is a JSON line with
 * either a prompt to send to a Claude Code terminal, or a focus
 * directive to bring this VS Code window forward.
 *
 * The bridge picks a target terminal by:
 *   1. The most recently active terminal whose name matches the
 *      configured pattern (default "claude", case-insensitive)
 *   2. Falling back to the active terminal if no match
 *   3. Failing silently and logging if no terminal is open
 *
 * Multi-window VS Code: every window runs its own bridge. To avoid
 * duplicate processing, an extension instance only handles a message
 * if the message's session_id maps to a session whose cwd matches
 * this window's workspace folder. If no mapping is found, all
 * windows attempt to handle (last writer wins on file truncation).
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { writePresenceFiles, presenceFilename, legacyPresenceFilename } from './presence.js';
import { cwdToSlug } from './slug.js';
import { CcSessionLatch } from './cc-session-latch.js';
import { buildBridgePayload } from './bridge-payload.js';
import {
  resultFileForClaim,
  buildWorkspaceInjectResultPayload,
  isResultFile,
  isStaleResultFile,
} from './workspace-inject-result.js';

const channel = vscode.window.createOutputChannel('DevNeural Bridge');

/* Bridge messages from the daemon. The bridge is responsible only for
 * delivering text into the matching Claude terminal via VS Code's
 * terminal API. Focus and Nav-mode key inject moved to the
 * StreamDeck.App tray app, which holds standing OS focus rights that
 * a browser-spawned VS Code extension host cannot match.
 *
 *   text + commit=true  (default)  -> paste as a new prompt and hit
 *                                      Enter; the user-typed-and-sent
 *                                      shape we use for queueSessionPrompt.
 *   text + commit=false             -> paste into the input buffer
 *                                      WITHOUT Enter so the user can
 *                                      review/edit before sending. The
 *                                      curator pushes suggestions through
 *                                      this path. */
interface BridgeMessage {
  queued_at: string;
  text?: string;
  commit?: boolean;
}

interface SessionMapping {
  session_id: string;
  cwd?: string;
  project_root?: string;
}

let watchTimer: NodeJS.Timeout | undefined;
let lastOffsets = new Map<string, number>();
let enabled = true;

/* Per-window offset persistence so VS Code reloads don't replay the
 * entire bridge inbox backlog (which can fire stale mic toggles or
 * key presses queued hours ago). The offsets file is keyed by
 * workspace folder so multiple VS Code windows don't trample each
 * other's cursors. */
function getOffsetsFile(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folderKey = folders[0]?.uri.fsPath?.replace(/[\\/:*?"<>|]/g, '_') ?? 'no-workspace';
  const dir = path.posix.join(getDataRoot(), 'session-bridge', '.offsets');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return path.posix.join(dir, `${folderKey}.json`);
}

function loadOffsets(): void {
  const file = getOffsetsFile();
  if (!fs.existsSync(file)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, number>;
    lastOffsets = new Map(Object.entries(raw));
  } catch {
    /* ignore */
  }
}

let offsetsSaveTimer: NodeJS.Timeout | undefined;
function saveOffsetsDebounced(): void {
  if (offsetsSaveTimer) return;
  offsetsSaveTimer = setTimeout(() => {
    offsetsSaveTimer = undefined;
    try {
      const obj: Record<string, number> = {};
      for (const [k, v] of lastOffsets) obj[k] = v;
      fs.writeFileSync(getOffsetsFile(), JSON.stringify(obj), 'utf-8');
    } catch {
      /* ignore */
    }
  }, 500);
}

function getDataRoot(): string {
  const cfg = vscode.workspace.getConfiguration('devneural.bridge');
  const raw = (cfg.get<string>('dataRoot') ?? 'C:/dev/data/skill-connections')
    .replace(/\\/g, '/')
    .replace(/^~/, os.homedir().replace(/\\/g, '/'));
  return raw;
}

/* Path normalisation used everywhere we compare a Claude Code cwd, a
 * VS Code workspace fsPath, or a StreamDeck.App identity-file Cwd.
 * Steps:
 *   1. Backslashes -> forward slashes (Windows mixed-style paths).
 *   2. Collapse runs of slashes -> single slash. The StreamDeck.App
 *      tray writes identity files with double-escaped paths
 *      ("C://dev//Projects//DevNeural"); without this collapse the
 *      identity-file Cwd never matches the VS Code terminal cwd and
 *      the mirror silently drops every event.
 *   3. Lowercase (Windows is case-insensitive on disk; VS Code and
 *      the transcript records often disagree on drive-letter case).
 *   4. Strip trailing slash. */
function normalizePath(s: string): string {
  return s
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase()
    .replace(/\/$/, '');
}

function getBridgeDir(): string {
  return path.posix.join(getDataRoot(), 'session-bridge');
}

function getTerminalPattern(): string {
  return (
    vscode.workspace
      .getConfiguration('devneural.bridge')
      .get<string>('terminalNamePattern') ?? 'claude'
  ).toLowerCase();
}

function isEnabled(): boolean {
  return (
    vscode.workspace.getConfiguration('devneural.bridge').get<boolean>('enabled') ??
    true
  );
}

/* Cache of terminal id -> "is this running claude" so we don't shell
 * out to wmic on every tick. Cleared when terminals open or close.
 *
 * Negative entries time out after 5s so a terminal that was empty at
 * first check (user opens VS Code, claude not started yet) becomes
 * eligible for re-detection once the user runs `claude` in that
 * shell. Without this, claudeTerminalCache.set(t, false) is sticky
 * for the life of the Terminal object and the bridge never picks the
 * worker up. Regression observed 2026-05-15. */
type ClaudeCacheEntry = { value: boolean; ts: number };
const NEG_CACHE_TTL_MS = 5_000;
const claudeTerminalCache = new Map<vscode.Terminal, ClaudeCacheEntry>();
function clearClaudeTerminalCache(): void {
  claudeTerminalCache.clear();
}
function readClaudeCache(t: vscode.Terminal): boolean | undefined {
  const e = claudeTerminalCache.get(t);
  if (!e) return undefined;
  if (e.value === false && Date.now() - e.ts > NEG_CACHE_TTL_MS) {
    claudeTerminalCache.delete(t);
    return undefined;
  }
  return e.value;
}
function writeClaudeCache(t: vscode.Terminal, value: boolean): void {
  claudeTerminalCache.set(t, { value, ts: Date.now() });
}

interface ProcRow {
  pid: number;
  ppid: number;
  cmd: string;
}

/* Walk the Windows process tree from a root pid; return any descendant
 * whose ExecutablePath or CommandLine contains "claude". One wmic call
 * for the whole snapshot, then BFS in memory.
 *
 * wmic is deprecated in Windows 11 but still ships. If it's missing
 * we fall back to PowerShell Get-CimInstance which is the modern
 * equivalent. Both produce the same shape. */
async function findClaudeDescendant(rootPid: number): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const rows = await snapshotProcesses();
  if (rows.length === 0) return false;
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = byParent.get(r.ppid) ?? [];
    list.push(r);
    byParent.set(r.ppid, list);
  }
  const stack: number[] = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const children = byParent.get(cur) ?? [];
    for (const c of children) {
      if (/claude/i.test(c.cmd)) return true;
      stack.push(c.pid);
    }
  }
  return false;
}

let cachedSnapshot: { rows: ProcRow[]; ts: number } | null = null;
async function snapshotProcesses(): Promise<ProcRow[]> {
  // 4-second cache: bridge tick is 750ms, identifying many terminals
  // in a row would otherwise spawn a wmic per terminal per tick.
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshot.ts < 4_000) {
    return cachedSnapshot.rows;
  }
  const rows = await runProcessSnapshot();
  cachedSnapshot = { rows, ts: now };
  return rows;
}

function runProcessSnapshot(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    // PowerShell Get-CimInstance is the modern replacement for wmic
    // and ships on every Windows 10+. Single -Command invocation,
    // CSV output, parse line-by-line.
    const psCmd =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation";
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psCmd],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        const rows: ProcRow[] = [];
        const lines = stdout.split(/\r?\n/);
        // Skip header
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          // Naive CSV split: fields are quoted, commas inside quotes
          // are valid. Use a regex that respects quoted segments.
          const m = line.match(/^"(\d+)","(\d+)","(.*)"$/);
          if (!m) continue;
          rows.push({
            pid: Number(m[1]),
            ppid: Number(m[2]),
            cmd: m[3] ?? '',
          });
        }
        resolve(rows);
      },
    );
  });
}

async function isClaudeTerminal(t: vscode.Terminal): Promise<boolean> {
  const cached = readClaudeCache(t);
  if (cached !== undefined) return cached;
  let pid: number | undefined;
  try {
    pid = await t.processId;
  } catch {
    pid = undefined;
  }
  if (!pid) {
    writeClaudeCache(t, false);
    return false;
  }
  const found = await findClaudeDescendant(pid);
  writeClaudeCache(t, found);
  return found;
}

/* Async terminal resolution. The tick loop awaits this so we don't
 * deliver a message before we know which terminal is the Claude one.
 * Resolution order:
 *
 *   1. Configured terminalNamePattern matches a terminal name.
 *      Fastest, also covers the user's explicit Pick Terminal flow.
 *   2. Process-tree auto-detect: walk children of each terminal's
 *      shell pid; any descendant whose CommandLine contains "claude"
 *      claims the terminal. This is what catches Claude Code's
 *      actual node-based shell when the terminal name is "PowerShell"
 *      or "1: pwsh".
 *
 * If neither resolves, we return undefined. The user-facing notice
 * gives them the explicit Pick Terminal escape hatch. */
async function findTargetTerminalAsync(): Promise<vscode.Terminal | undefined> {
  const pattern = getTerminalPattern();
  const terminals = vscode.window.terminals;
  if (terminals.length === 0) return undefined;

  // 1. Name pattern (cheap path).
  const active = vscode.window.activeTerminal;
  if (active && active.name.toLowerCase().includes(pattern)) {
    return active;
  }
  for (let i = terminals.length - 1; i >= 0; i--) {
    const t = terminals[i];
    if (t && t.name.toLowerCase().includes(pattern)) {
      return t;
    }
  }

  // 2. Process-tree auto-detect.
  // Prefer the active terminal so multi-terminal windows stay
  // predictable; only fall through to others if active isn't Claude.
  if (active && (await isClaudeTerminal(active))) {
    return active;
  }
  for (let i = terminals.length - 1; i >= 0; i--) {
    const t = terminals[i];
    if (!t) continue;
    if (await isClaudeTerminal(t)) return t;
  }

  // 3. Aggressive last-resort auto-bind. Per user direction
  // (2026-05-21), the bridge must never prompt for a terminal pick
  // and the cost of an occasional wrong-terminal pick is acceptable
  // ("we can afford the mistake"). When no other resolution path
  // succeeds, pick the most recently active terminal in this window
  // (or, if none is active, the most recently created one). The
  // user declared the brainstorm <-> CC session binding via the
  // Lex supervises dropdown; the bridge honors that intent rather
  // than blocking on disambiguation.
  if (active) {
    channel.appendLine(
      `[auto-bind] no name/pid match; defaulting to active terminal "${active.name}"`,
    );
    return active;
  }
  const fallback = terminals[terminals.length - 1];
  if (fallback) {
    channel.appendLine(
      `[auto-bind] no name/pid match and no active terminal; defaulting to most recent "${fallback.name}"`,
    );
    return fallback;
  }
  return undefined;
}

/* focusWindow / injectKey / buildSinglePs / buildChordPs lived here
 * before the StreamDeck.App tray app took ownership of OS focus + key
 * inject. The bridge could never reliably honour SetForegroundWindow
 * because Windows refuses foreground swaps from processes that don't
 * own focus and didn't receive the most recent input event, and a
 * VS Code extension host spawned by the browser's process tree
 * satisfies neither. Removed; see %LOCALAPPDATA%\\stream-deck\\
 * virtual-input\\<sessionId>.in for the current path. */

/* "no terminal" notice. The bridge used to surface a popup with a
 * "Pick Terminal" action button on first occurrence and a transient
 * status-bar message thereafter. Per user direction (2026-05-21),
 * the bridge must never prompt the user to pick a terminal -- the
 * Lex supervises dropdown is the source of truth for which CC
 * session a brainstorm controls, and the bridge is expected to
 * resolve the target terminal automatically. When resolution
 * genuinely fails, log to the output channel only. No UI. */
function noticeNoTerminal(): void {
  channel.appendLine(
    '[skip] no claude terminal resolvable in this window; no UI prompt -- waiting for onDidOpenTerminal or a single-terminal workspace auto-bind',
  );
}

type DeliveryOutcome = 'delivered' | 'dropped' | 'retry';

async function handleMessage(message: BridgeMessage): Promise<DeliveryOutcome> {
  if (!message.text) {
    channel.appendLine('[skip] message has no text');
    return 'dropped';
  }

  let terminal: vscode.Terminal | undefined;
  try {
    terminal = await findTargetTerminalAsync();
  } catch (err) {
    channel.appendLine(`[error] terminal resolution failed: ${(err as Error).message}`);
    /* Resolution itself crashed (wmic/Get-CimInstance error). Treat
     * as retry so a transient process-snapshot failure does not eat
     * the marker; the next tick re-attempts. */
    return 'retry';
  }
  if (!terminal) {
    channel.appendLine(
      '[skip] no terminal in this window; another bridge instance is expected to handle it',
    );
    noticeNoTerminal();
    /* Bug 3c (2026-05-22): do NOT advance the offset when no terminal
     * is resolvable in this window. Another bridge instance is
     * expected to deliver, and if none does the marker ages out into
     * the >90s skip-stale path on its own (line ~642). Advancing here
     * would have caused the silent-drop bug documented in
     * docs/bugs/2026-05-22-worker-discovery-both-launch-paths.md. */
    return 'retry';
  }
  try {
    const commit = message.commit !== false; // default true
    channel.appendLine(
      `[${commit ? 'send' : 'suggest'}] -> "${terminal.name}": ${message.text.slice(0, 80)}${
        message.text.length > 80 ? '...' : ''
      }`,
    );
    terminal.show(true);
    /* Bracketed-paste wrap for any multi-line or long payload.
     * VS Code's terminal.sendText writes raw to the PTY without the
     * bracketed-paste envelope that the integrated paste action (Ctrl+V)
     * supplies, so every literal '\n' in the payload was getting read
     * by Claude Code's TUI as "submit this prompt now." Net effect:
     * a multi-line cross-session inject landed as just its first line.
     * CSI 2004 / xterm bracketed paste (\x1b[200~ ... \x1b[201~) marks
     * the whole payload as one atomic paste; CC's input layer holds
     * the buffer until the terminator arrives and only then commits.
     *
     * Wrap when the payload has at least one newline OR is longer than
     * the safety threshold (200 chars). Single-line short payloads
     * (Nav-style pointers, one-liner suggestions) skip the wrap so a
     * shell that mishandles the escapes does not regress on the
     * common path. */
    /* Atomic write: body + (optional) trailing '\r' in a single
     * sendText call. The previous shape did two separate sendText
     * calls separated by an 80ms gap; that worked most of the time
     * but raced intermittently on a busy VS Code render frame
     * (bug doc 2026-05-14-bridge-inject-missing-enter). The
     * trailing '\r' occasionally landed before the bracketed-paste
     * terminator finished flushing through VS Code's PTY write
     * queue, so CC's TUI treated the carriage return as pasted
     * text instead of Enter and the prompt sat in the input field
     * forever. A single sendText delivers the bytes in one
     * underlying PTY write, so by the time the '\r' arrives the
     * \x1b[201~ terminator has already closed the paste envelope. */
    const wrapped = buildBridgePayload(message.text, commit);
    terminal.sendText(wrapped, false);
    if (commit) {
      /* Safety-net Enter: on bracketed-paste-wrapped payloads the
       * atomic body+\r sometimes loses the trailing CR because VS
       * Code's PTY write queue closes the paste envelope after the
       * \r byte (observed 2026-05-15 on multi-hundred-char wrapped
       * payloads). A follow-up bare \r 120ms later commits the
       * input. If the original \r already fired, this fires on an
       * empty prompt, which CC's TUI treats as a no-op. */
      setTimeout(() => {
        try {
          terminal.sendText('\r', false);
        } catch {
          /* terminal disposed; nothing to commit */
        }
      }, 120);
      channel.appendLine(
        `[send] payload shipped (len=${wrapped.length}); safety-net Enter scheduled +120ms`,
      );
    }
    return 'delivered';
  } catch (err) {
    channel.appendLine(`[error] sendText failed: ${(err as Error).message}`);
    /* sendText raised after we identified a terminal. The PTY write
     * may have partially landed; advancing the offset avoids an
     * infinite retry that re-pastes a fragment. Drop the marker. */
    return 'dropped';
  }
}

/* Cache: session_id -> { cwd, resolvedAt }. Bounded TTL so a session
 * that was first observed before its meta file existed (cached as '')
 * gets re-resolved later instead of being misrouted forever. The
 * positive-resolution case is also bounded so a session that moved
 * directories is picked up on the next miss. */
const CWD_CACHE_TTL_MS = 60_000;
const cwdCache = new Map<string, { cwd: string; resolvedAt: number }>();

function resolveSessionCwd(sessionId: string): string {
  const cached = cwdCache.get(sessionId);
  if (cached) {
    const fresh = Date.now() - cached.resolvedAt < CWD_CACHE_TTL_MS;
    // Always re-resolve empty entries; only honour positive cache hits
    // within the TTL window.
    if (fresh && cached.cwd) return cached.cwd;
    if (fresh && cached.cwd === '') return '';
  }

  const dataRoot = getDataRoot();
  const metaFile = path.posix.join(
    dataRoot,
    'session-state',
    `${sessionId}.meta.json`,
  );
  if (fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as SessionMapping;
      const cwd = (meta.cwd ?? meta.project_root ?? '').replace(/\\/g, '/');
      cwdCache.set(sessionId, { cwd, resolvedAt: Date.now() });
      return cwd;
    } catch {
      /* fall through to jsonl scan */
    }
  }

  // Fallback: scan ~/.claude/projects/<slug>/<sessionId>.jsonl for the
  // first record carrying a cwd. The summarizer might not have run yet
  // for this session, so the meta file is missing; the actual
  // transcript on disk is the canonical source either way.
  const claudeRoot = path.posix.join(
    os.homedir().replace(/\\/g, '/'),
    '.claude',
    'projects',
  );
  if (fs.existsSync(claudeRoot)) {
    try {
      const slugs = fs.readdirSync(claudeRoot, { withFileTypes: true });
      for (const slug of slugs) {
        if (!slug.isDirectory()) continue;
        const file = path.posix.join(claudeRoot, slug.name, `${sessionId}.jsonl`);
        if (!fs.existsSync(file)) continue;
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(8 * 1024);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          const text = buf.toString('utf-8', 0, n);
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const rec = JSON.parse(trimmed) as { cwd?: string };
              if (typeof rec.cwd === 'string' && rec.cwd) {
                const cwd = rec.cwd.replace(/\\/g, '/');
                cwdCache.set(sessionId, { cwd, resolvedAt: Date.now() });
                return cwd;
              }
            } catch {
              /* skip */
            }
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      /* ignore */
    }
  }

  cwdCache.set(sessionId, { cwd: '', resolvedAt: Date.now() });
  return '';
}

function shouldHandleSession(sessionId: string): boolean {
  /* Decide whether THIS VS Code window should process the bridge
   * message for this session. A session belongs to whichever window
   * has the matching workspace folder open; multiple windows with
   * independent bridges otherwise all try and clobber each other.
   *
   * Resolution chain:
   *   1. session-state meta file (written by summarizer)
   *   2. ~/.claude/projects/<slug>/<sessionId>.jsonl first cwd record
   * If both fail, we bail to "true" so SOME window handles it; the
   * strict terminal match in handleMessage protects against
   * delivering to an unrelated shell. */
  const sessionCwd = resolveSessionCwd(sessionId);
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!sessionCwd || folders.length === 0) return true;
  // Windows paths are case-insensitive on disk but the casing recorded
  // in the Claude Code transcript ("C:\dev\...") often differs from the
  // casing VS Code uses for its workspace fsPath ("c:\dev\..."), which
  // turned a case mismatch into a silent "skip every prompt".
  const sessionCwdLower = normalizePath(sessionCwd);
  return folders.some((f) => {
    const folder = normalizePath(f.uri.fsPath);
    return sessionCwdLower === folder || sessionCwdLower.startsWith(`${folder}/`);
  });
}

/* Per-file in-flight chain. tick() calls processFile every 750ms;
 * without serialization a slow terminal lookup on one message could
 * let a later tick read the same file again before the prior batch's
 * handleMessage calls had run, and prompts could land out of order.
 *
 * Bug 3c (2026-05-22): the chain now threads each handleMessage's
 * DeliveryOutcome back through the file's offset advance. A 'retry'
 * outcome (no terminal in this window right now) HALTS offset
 * advancement for the file until either the message ages out into
 * skip-stale at the >90s gate OR another tick succeeds. Without the
 * gate the offset advanced unconditionally and silently dropped any
 * marker that landed during a no-terminal window. */
interface FileChainState {
  tail: Promise<void>;
  /* Highest contiguous byte offset that has been ACKed by a delivery
   * outcome ('delivered' or 'dropped'). saveOffsetsDebounced reads
   * lastOffsets which is committed from this value when the chain
   * advances. */
  committedOffset: number;
  /* True while the chain is paused on a 'retry' outcome. processFile
   * will not enqueue further messages from beyond this point until
   * the retry resolves on a later tick. */
  halted: boolean;
}
const fileChain = new Map<string, FileChainState>();

function getFileChain(file: string, initialOffset: number): FileChainState {
  let state = fileChain.get(file);
  if (!state) {
    state = { tail: Promise.resolve(), committedOffset: initialOffset, halted: false };
    fileChain.set(file, state);
  }
  return state;
}

function enqueueDelivery(
  file: string,
  message: BridgeMessage,
  byteSize: number,
  startOffset: number,
): void {
  const state = getFileChain(file, startOffset);
  state.tail = state.tail
    .catch(() => undefined)
    .then(async () => {
      let outcome: DeliveryOutcome = 'dropped';
      try {
        outcome = await handleMessage(message);
      } catch (err) {
        channel.appendLine(
          `[deliver-error] ${(err as Error)?.message ?? String(err)}`,
        );
        outcome = 'dropped';
      }
      if (outcome === 'retry') {
        state.halted = true;
        return;
      }
      state.committedOffset = startOffset + byteSize;
      state.halted = false;
      lastOffsets.set(file, state.committedOffset);
      saveOffsetsDebounced();
    });
}

function processFile(file: string): void {
  if (!isEnabled()) return;
  const sessionId = path.basename(file, '.in');
  if (!shouldHandleSession(sessionId)) {
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  const lastOffset = lastOffsets.get(file) ?? 0;
  if (stat.size === lastOffset) return;
  if (stat.size < lastOffset) {
    // File was truncated; restart from beginning
    lastOffsets.set(file, 0);
    fileChain.delete(file);
    return processFile(file);
  }

  /* Honour a prior 'retry' halt: another tick is going to ack the
   * outstanding marker before we read past it. processFile bails so
   * we do not double-enqueue the same line on every tick. The chain
   * itself will lift the halt once handleMessage resolves with
   * 'delivered' or 'dropped'. */
  const state = fileChain.get(file);
  if (state?.halted) return;

  const fd = fs.openSync(file, 'r');
  try {
    const length = stat.size - lastOffset;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, lastOffset);
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    let cursorOffset = lastOffset;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const isLast = i === lines.length - 1;
      const isLastIncomplete = isLast && !text.endsWith('\n');
      if (isLastIncomplete) break;
      // split('\n') of "a\nb\n" yields ["a","b",""]; the trailing empty
      // token after a final newline is not a real line and must not
      // contribute to `consumed`, otherwise the offset overshoots EOF
      // by 1 byte and the next tick treats the unchanged file as
      // truncated, replaying every message every 750ms.
      if (isLast && line === '' && text.endsWith('\n')) break;
      const byteSize = Buffer.byteLength(line, 'utf-8') + 1;
      const startOffset = cursorOffset;
      cursorOffset += byteSize;
      const trimmed = line.trim();
      if (!trimmed) {
        /* Blank line: not a real marker. Commit its byte size as a
         * dropped no-op so the offset still advances past it. */
        const blankState = getFileChain(file, startOffset);
        blankState.committedOffset = startOffset + byteSize;
        lastOffsets.set(file, blankState.committedOffset);
        saveOffsetsDebounced();
        continue;
      }
      try {
        const message = JSON.parse(trimmed) as BridgeMessage;
        // Drop stale messages so a queue that piled up while the bridge
        // was down does not flood the terminal hours later. Threshold
        // matches the daemon's bridge-offline window plus a buffer for
        // tick latency; anything older was almost certainly queued
        // against a dead bridge.
        const queuedMs = Date.parse(message.queued_at);
        if (Number.isFinite(queuedMs) && Date.now() - queuedMs > 90_000) {
          channel.appendLine(
            `[skip-stale] queued_at=${message.queued_at} age=${Math.round((Date.now() - queuedMs) / 1000)}s text=${(message.text ?? '').slice(0, 60)}`,
          );
          /* Stale drop: commit through the chain so a retry ahead of
           * us in the same tick is not jumped over. The chain's tail
           * is sequential, so appending a no-op resolver preserves
           * the in-order semantics. */
          const stale = getFileChain(file, startOffset);
          stale.tail = stale.tail.catch(() => undefined).then(() => {
            stale.committedOffset = startOffset + byteSize;
            stale.halted = false;
            lastOffsets.set(file, stale.committedOffset);
            saveOffsetsDebounced();
          });
          continue;
        }
        enqueueDelivery(file, message, byteSize, startOffset);
      } catch (err) {
        channel.appendLine(
          `[parse-error] ${(err as Error).message}: ${trimmed.slice(0, 200)}`,
        );
        const parseState = getFileChain(file, startOffset);
        parseState.tail = parseState.tail.catch(() => undefined).then(() => {
          parseState.committedOffset = startOffset + byteSize;
          parseState.halted = false;
          lastOffsets.set(file, parseState.committedOffset);
          saveOffsetsDebounced();
        });
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/* Liveness heartbeat. The daemon refuses to queue prompts unless this
 * file's mtime is recent (default <30s), so we touch it on every tick.
 * Without this, a closed VS Code window left messages buffering in the
 * bridge inbox for hours and dumped them all at once on next reload. */
function writeHeartbeat(): void {
  const dir = getBridgeDir();
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return;
    }
  }
  const file = path.posix.join(dir, '.heartbeat');
  try {
    const now = Date.now();
    fs.writeFileSync(file, String(now), 'utf-8');
  } catch {
    /* ignore */
  }
}

/* Per-window presence registration for the project-anchor model. The
 * daemon polls <bridgeDir>/.bridge-presence/<workspace-key>.json and
 * flips matching project_session rows live, dedupes multi-window
 * connections, and clears stale anchors. Workspace key matches the
 * existing per-window offsets key so two windows on the same
 * workspace use the same file (last writer wins, which is fine: the
 * daemon counts files, not writers). bridge_id is per-window so the
 * daemon can still count distinct connections via the dedup key in
 * .bridge-presence-id. */
let cachedBridgeId: string | undefined;
function getBridgeId(context: vscode.ExtensionContext): string {
  if (cachedBridgeId) return cachedBridgeId;
  const key = 'devneural.bridgeId';
  const existing = context.globalState.get<string>(key);
  if (existing) {
    cachedBridgeId = existing;
    return existing;
  }
  /* Math.random + Date.now is sufficient — this id only has to be
   * unique among concurrently-running bridges on one machine. */
  const id = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  void context.globalState.update(key, id);
  cachedBridgeId = id;
  return id;
}

function getPresenceDir(): string {
  return path.posix.join(getBridgeDir(), '.bridge-presence');
}

/* Sticky cc_session_id latch. Replaces the prior 30s mtime-window
 * scan that was dropping the UUID the moment the worker stopped
 * writing turns (idle >30s). The latch picks the newest jsonl in
 * the slug dir without a freshness gate and keeps reporting it
 * until VS Code deactivates the extension OR a newer jsonl UUID
 * supersedes on disk. Heartbeat persistence is owned by the
 * presence-file mtime on the daemon side; this module is only
 * responsible for the cwd -> uuid mapping. */
const ccSessionLatch = new CcSessionLatch({
  claudeProjectsRoot: path.posix.join(
    os.homedir().replace(/\\/g, '/'),
    '.claude',
    'projects',
  ),
});

let presenceContext: vscode.ExtensionContext | undefined;
function writePresence(): void {
  if (!presenceContext) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  const bridgeId = getBridgeId(presenceContext);
  /* One presence file per top-level workspace folder. Multi-root
   * windows declare presence for every root; the daemon dedupes by
   * cwd. */
  writePresenceFiles({
    presenceDir: getPresenceDir(),
    folders: folders.map((f) => ({ fsPath: f.uri.fsPath })),
    bridgeId,
    now: new Date(),
    ccSessionLookup: (cwd) => {
      /* Task E (2026-05-13): latch-first lookup.
       *
       * The prior order consulted daemonActiveSessions first, which
       * created a self-reinforcing loop after /clear: the daemon
       * cache reflected whatever cc_session_id the bridge had last
       * reported, the bridge re-reported it without re-asking the
       * latch, and the daemon kept reading the stale id from its
       * own /sessions response. The latch is the authoritative
       * source for the live jsonl on this host (it scans the slug
       * dir directly with the 60s anti-flap window in
       * CcSessionLatch), so it must run first. The daemon cache
       * stays as a fallback for transient filesystem hiccups when
       * the latch returns undefined. */
      const latched = ccSessionLatch.resolve(cwd);
      if (latched) return latched;
      const slug = cwdToSlug(cwd).toLowerCase();
      return daemonActiveSessions.get(slug);
    },
    /* Bug 3b (2026-05-22): per-UUID deliverability flag. Honest
     * answer to "does THIS bridge own a terminal that can receive a
     * marker for this UUID right now?" Used by the daemon to route
     * /lex/inject-cross-session away from windows that latched the
     * UUID but have no terminal (e.g. the user opened a second VS
     * Code window, latched first, then closed it to keep the worker
     * in window 2).
     *
     * Best-effort sync: walks vscode.window.terminals and consults
     * the existing claudeTerminalCache. A terminal whose process
     * tree contains a claude.exe (via isClaudeTerminal cache) is
     * accepted as the owner of whichever UUID the latch resolves
     * for this cwd. A cold cache returns false here AND fires a
     * background isClaudeTerminal() so the next tick has a real
     * answer; the daemon's migration grace treats a flagless or
     * false-from-cold-cache record as deliverable for one tick. */
    hasTerminalForUuidLookup: (_cwd, _uuid) => hasClaudeTerminalInThisWindow(),
  });
}

/* See hasTerminalForUuidLookup wire-up in writePresence. Sync probe:
 *   - any terminal in this window whose claudeTerminalCache says true
 *     => true (deliverable)
 *   - all terminals say false => false (definitely not deliverable)
 *   - some uncached terminals => warm them async, return whether any
 *     already-cached terminal said true (the cold-start tick yields a
 *     conservative false; daemon's migration grace covers one tick) */
function hasClaudeTerminalInThisWindow(): boolean {
  const terminals = vscode.window.terminals;
  if (terminals.length === 0) return false;
  let anyTrue = false;
  for (const t of terminals) {
    const cached = readClaudeCache(t);
    if (cached === true) {
      anyTrue = true;
      continue;
    }
    if (cached === undefined) {
      /* Fire-and-forget; isClaudeTerminal writes back into the cache
       * so the next presence tick gets a real answer. */
      void isClaudeTerminal(t).catch(() => undefined);
    }
  }
  return anyTrue;
}

function clearPresence(): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  const dir = getPresenceDir();
  if (!fs.existsSync(dir)) return;
  if (!presenceContext) return;
  const bridgeId = getBridgeId(presenceContext);
  for (const folder of folders) {
    const cwd = folder.uri.fsPath.replace(/\\/g, '/');
    /* Scrub this bridge's per-bridge-id file plus the legacy
     * cwd-only file (pre-2026-05-22). Both are removed on deactivate
     * so a stale presence does not survive a window close. */
    const candidates = [
      path.posix.join(dir, `${presenceFilename(cwd, bridgeId)}.json`),
      path.posix.join(dir, `${legacyPresenceFilename(cwd)}.json`),
    ];
    for (const file of candidates) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  }
}

function tick(): void {
  if (!enabled || !isEnabled()) return;
  writeHeartbeat();
  writePresence();
  const dir = getBridgeDir();
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.in')) {
      processFile(path.posix.join(dir, e.name));
    }
  }
  processWorkspaceInjects();
}

/* Workspace-targeted command injection. Used by the dashboard's
 * "Start Claude" buttons: when no Claude session exists yet for a
 * project the dashboard has no session_id to address, so it writes a
 * marker keyed by workspace path here. The bridge in the matching
 * VS Code window picks it up, opens (or reuses) a terminal at that
 * cwd, types the command, presses Enter, and deletes the marker.
 *
 * Markers older than 10 minutes are deleted without firing — they
 * are stale signals from a previous run that the user is no longer
 * waiting on, and replaying them would surprise the user with a
 * Claude window appearing later. */
const WORKSPACE_INJECT_TTL_MS = 10 * 60_000;
function getWorkspaceInjectDir(): string {
  return path.posix.join(getBridgeDir(), '.workspace-inject');
}

/* WP-H: delivery-result files share the marker directory and the
 * marker TTL. No separate cleanup timer -- this runs from the same
 * tick as the marker sweep below. */
function cleanupStaleResultFiles(dir: string, entries: fs.Dirent[]): void {
  const now = Date.now();
  for (const e of entries) {
    if (!e.isFile() || !isResultFile(e.name)) continue;
    const file = path.posix.join(dir, e.name);
    try {
      const stat = fs.statSync(file);
      if (isStaleResultFile(stat.mtimeMs, now, WORKSPACE_INJECT_TTL_MS)) {
        fs.unlinkSync(file);
      }
    } catch {
      /* ignore -- another window's tick may have already removed it */
    }
  }
}

/* WP-H: write the delivery-result file the daemon's pollInjectResult
 * (07-daemon src/dashboard/projects-new.ts) polls for. Best-effort:
 * a failure to write the result file must never throw out of
 * runWorkspaceInject -- the inject itself already happened (or
 * failed) and the claim file cleanup in the caller's `finally` still
 * has to run either way. */
function writeWorkspaceInjectResult(
  claimFile: string,
  workspace: string,
  result: { ok: boolean; error?: string },
): void {
  const file = resultFileForClaim(claimFile);
  const payload = buildWorkspaceInjectResultPayload(workspace, result);
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    channel.appendLine(
      `[workspace-inject] failed to write result file ${file}: ${(err as Error).message}`,
    );
  }
}

interface WorkspaceInjectMarker {
  workspace: string;
  command: string;
  queued_at: string;
}

function processWorkspaceInjects(): void {
  const dir = getWorkspaceInjectDir();
  if (!fs.existsSync(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  /* WP-H: sweep stale delivery-result files on the same tick that
   * sweeps stale markers, instead of running a second timer. Any
   * window's tick can safely do this — result files are inert
   * bookkeeping, not workspace-owned pending work, so there's no
   * "owns this workspace" gate like the marker loop below. */
  cleanupStaleResultFiles(dir, entries);

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  const myWorkspaces = folders.map((f) => normalizePath(f.uri.fsPath));

  for (const e of entries) {
    /* '.result.json' entries also end in '.json' but are delivery
     * results, not markers awaiting a command — exclude them or
     * they'd get parsed as a WorkspaceInjectMarker (undefined
     * .command / .queued_at) and claimed/run as bogus work. */
    if (!e.isFile() || !e.name.endsWith('.json') || isResultFile(e.name)) continue;
    const file = path.posix.join(dir, e.name);
    let marker: WorkspaceInjectMarker;
    try {
      marker = JSON.parse(fs.readFileSync(file, 'utf-8')) as WorkspaceInjectMarker;
    } catch {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
      continue;
    }

    const queued = Date.parse(marker.queued_at);
    if (
      Number.isFinite(queued) &&
      Date.now() - queued > WORKSPACE_INJECT_TTL_MS
    ) {
      channel.appendLine(
        `[workspace-inject] skip stale ${marker.workspace} (age ${Math.round(
          (Date.now() - queued) / 1000,
        )}s)`,
      );
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
      continue;
    }

    const target = normalizePath(marker.workspace);
    const owns = myWorkspaces.some(
      (ws) => target === ws || target.startsWith(`${ws}/`),
    );
    if (!owns) continue;

    /* Atomically claim the marker by renaming before doing any work,
     * so two VS Code windows that both contain the workspace don't
     * both fire the command. The losing rename throws ENOENT and
     * we move on. */
    const claim = file + '.claim';
    try {
      fs.renameSync(file, claim);
    } catch {
      continue;
    }

    void runWorkspaceInject(marker, claim);
  }
}

async function runWorkspaceInject(
  marker: WorkspaceInjectMarker,
  claimFile: string,
): Promise<void> {
  const wsNormalized = normalizePath(marker.workspace.replace(/\\/g, '/'));
  try {
    const wsPath = marker.workspace.replace(/\\/g, '/');
    /* Always create a fresh terminal at the workspace cwd. We used to
     * try to reuse the active terminal as an optimization, but that
     * was unsafe: VS Code's activeTerminal can point at any shell the
     * user is focused on (an unrelated PowerShell, a build watcher, a
     * debug REPL), and sendText would type `claude` into it. Creating
     * a new terminal with explicit cwd guarantees the command lands
     * in the right place at the cost of one extra tile in the
     * terminal panel. */
    const target = vscode.window.createTerminal({
      name: 'Claude',
      cwd: vscode.Uri.file(wsPath),
    });
    target.show(true);
    /* Atomic write: command + '\r' in one sendText call. Matches the
     * same fix applied to handleMessage for the
     * 2026-05-14-bridge-inject-missing-enter regression. Two
     * sequential sendText calls with an 80ms gap raced under load
     * and the '\r' sometimes failed to commit the workspace-inject
     * command. */
    target.sendText(buildBridgePayload(marker.command, true), false);
    channel.appendLine(
      `[workspace-inject] ran "${marker.command}" in ${wsNormalized}`,
    );
    /* WP-H: tell the daemon's poller the inject actually landed. */
    writeWorkspaceInjectResult(claimFile, wsNormalized, { ok: true });
  } catch (err) {
    const message = (err as Error).message;
    channel.appendLine(`[workspace-inject] failed: ${message}`);
    /* WP-H: failure path also gets a result file so the daemon's
     * poller can report delivery:'failed' + the bridge error instead
     * of timing out to 'unconfirmed' for something we actually know
     * failed. */
    writeWorkspaceInjectResult(claimFile, wsNormalized, { ok: false, error: message });
  } finally {
    try {
      fs.unlinkSync(claimFile);
    } catch {
      /* ignore */
    }
  }
}

function startWatching(): void {
  if (watchTimer) return;
  loadOffsets();
  channel.appendLine(`[start] bridge dir: ${getBridgeDir()}`);
  channel.appendLine(`[start] terminal pattern: ${getTerminalPattern()}`);
  channel.appendLine(`[start] offsets restored: ${lastOffsets.size} files`);

  /* On first start in a new workspace (no offsets file yet), advance
   * the cursor to current end-of-file for every existing inbox file
   * so we don't replay backlog from before the bridge was installed
   * or before the user mapped their terminal. */
  if (lastOffsets.size === 0) {
    const dir = getBridgeDir();
    if (fs.existsSync(dir)) {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isFile() || !e.name.endsWith('.in')) continue;
          const full = path.posix.join(dir, e.name);
          try {
            const stat = fs.statSync(full);
            lastOffsets.set(full, stat.size);
          } catch {
            /* ignore */
          }
        }
        channel.appendLine(
          `[start] first run: skipped ${lastOffsets.size} backlog files`,
        );
        saveOffsetsDebounced();
      } catch {
        /* ignore */
      }
    }
  }
  watchTimer = setInterval(tick, 750);
}

function stopWatching(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = undefined;
  }
}

/* Terminal-output mirror.
 *
 * Subscribes to the FINALIZED shell-integration capture API
 * (vscode.window.onDidStartTerminalShellExecution +
 * TerminalShellExecution.read()). This replaces the removed
 * terminalDataWriteEvent proposal (onDidWriteTerminalData), which
 * VS Code 1.130 deleted. read() yields an AsyncIterable<string> of the
 * RAW bytes (including escape sequences) a command writes for the
 * lifetime of that execution; `claude` runs as one long-lived
 * execution, so read() streams its full-screen TUI output continuously.
 * Each chunk is buffered and forwarded to the daemon as a debounced
 * HTTP POST. The daemon ring-buffers and broadcasts to dashboard
 * clients over WebSocket so an iPad can watch the live TUI.
 *
 * No proposed-API flag is required anymore: the shell-execution API is
 * finalized (VS Code >= 1.93), so the extension no longer needs
 * --enable-proposed-api or an argv.json entry.
 *
 * Read-only mirror. Inputs still flow via the existing Steer box and
 * Nav grid. Failure modes:
 *   - Shell-execution API unavailable (VS Code < 1.93) -> log once,
 *     return; existing prompt-delivery flow keeps working.
 *   - Shell integration inactive in the terminal -> no start events
 *     fire; nothing to capture until it activates.
 *   - claude already running when the extension activates -> its start
 *     event already fired, so no execution to attach read() to; capture
 *     begins on the next claude launch in that terminal.
 *   - Daemon down -> POST throws; swallowed.
 *   - Command is not claude -> filtered out before any streaming.
 *
 * Resolves session_id from the terminal's cwd by scanning the
 * StreamDeck identity dir, the same source of truth the daemon
 * already uses for "active" detection. */
/* Mirror health state. Written to <bridgeDir>/.mirror-state.json so
 * the daemon (and through it the dashboard) can surface failure modes
 * without the user needing to inspect VS Code's Output panel. The
 * existing prompt-delivery heartbeat at <bridgeDir>/.heartbeat covers
 * the watcher loop's liveness; this covers the mirror loop's state. */
interface MirrorState {
  updated_at: string;
  api_available: boolean;
  subscribed: boolean;
  reason: string | null;
  tracked_terminals: number;
  last_flush_at: string | null;
  last_flush_session_id: string | null;
  last_flush_bytes: number | null;
  last_resolution_failure_at: string | null;
  last_resolution_failure_reason: string | null;
  last_post_error: string | null;
  last_post_error_at: string | null;
}

const mirrorState: MirrorState = {
  updated_at: new Date().toISOString(),
  api_available: false,
  subscribed: false,
  reason: 'not started',
  tracked_terminals: 0,
  last_flush_at: null,
  last_flush_session_id: null,
  last_flush_bytes: null,
  last_resolution_failure_at: null,
  last_resolution_failure_reason: null,
  last_post_error: null,
  last_post_error_at: null,
};

let mirrorStateSaveTimer: NodeJS.Timeout | undefined;
function writeMirrorStateDebounced(): void {
  if (mirrorStateSaveTimer) return;
  mirrorStateSaveTimer = setTimeout(() => {
    mirrorStateSaveTimer = undefined;
    try {
      const dir = getBridgeDir();
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      mirrorState.updated_at = new Date().toISOString();
      fs.writeFileSync(
        path.posix.join(dir, '.mirror-state.json'),
        JSON.stringify(mirrorState, null, 2),
        'utf-8',
      );
    } catch {
      /* ignore */
    }
  }, 500);
}

/* Bridge resolver fallback. The Stream Deck identity dir is the
 * authoritative source for terminal-cwd -> session_id, but if the
 * tray app isn't running (or hasn't registered yet, or its dir is
 * empty), the mirror has historically gone silent. We now keep a
 * lightweight cache of the daemon's own /sessions list (which itself
 * falls back to mtime-based liveness when the deck dir is missing
 * or empty) and use it as a second source of truth. Cache key is
 * the lowercase project_slug so the ancestor walk in
 * resolveSessionForTerminal can cheaply check each candidate cwd.
 *
 * Refreshed every 3 seconds while the mirror is active. Cheap; the
 * daemon serves /sessions in a few ms. */
const daemonActiveSessions = new Map<string, string>();
let daemonSessionsRefreshTimer: NodeJS.Timeout | undefined;

async function refreshDaemonSessions(): Promise<void> {
  try {
    const res = await fetch('http://127.0.0.1:3747/sessions', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      ok?: boolean;
      sessions?: Array<{
        session_id?: string;
        project_slug?: string;
        active?: boolean;
      }>;
    };
    if (!body.sessions) return;
    daemonActiveSessions.clear();
    for (const s of body.sessions) {
      if (!s.active) continue;
      if (!s.session_id || !s.project_slug) continue;
      daemonActiveSessions.set(s.project_slug.toLowerCase(), s.session_id);
    }
  } catch {
    /* daemon down or transient: keep stale cache rather than dropping
     * resolutions we already have */
  }
}

function startTerminalMirror(context: vscode.ExtensionContext): void {
  /* Finalized shell-integration capture (replaces the removed
   * terminalDataWriteEvent proposal). Present on VS Code >= 1.93.
   * Probe via typeof so an older host degrades to a logged no-op
   * instead of throwing on subscribe. */
  const shellExecApi = (
    vscode.window as unknown as {
      onDidStartTerminalShellExecution?: unknown;
    }
  ).onDidStartTerminalShellExecution;
  if (typeof shellExecApi !== 'function') {
    channel.appendLine(
      '[mirror] window.onDidStartTerminalShellExecution not available; update VS Code to >= 1.93 to enable terminal mirroring',
    );
    mirrorState.api_available = false;
    mirrorState.subscribed = false;
    mirrorState.reason =
      'terminal shell-integration capture API (window.onDidStartTerminalShellExecution) not available; requires VS Code >= 1.93';
    writeMirrorStateDebounced();
    return;
  }

  mirrorState.api_available = true;

  const buffers = new Map<vscode.Terminal, string>();
  const flushTimers = new Map<vscode.Terminal, NodeJS.Timeout>();
  const sessionIdCache = new Map<vscode.Terminal, string>();

  /* Terminals with at least one in-flight shell execution we are
   * mirroring. Drives mirrorState.tracked_terminals. A terminal can in
   * principle host nested executions (a sub-shell launched inside
   * claude's shell), so this is a refcount keyed by terminal rather
   * than a boolean set. */
  const execCount = new Map<vscode.Terminal, number>();
  function updateTracked(): void {
    mirrorState.tracked_terminals = execCount.size;
    writeMirrorStateDebounced();
  }

  function localAppData(): string {
    return (
      process.env.LOCALAPPDATA?.replace(/\\/g, '/') ??
      path.posix.join(os.homedir().replace(/\\/g, '/'), 'AppData', 'Local')
    );
  }

  function recordResolutionFailure(reason: string): void {
    mirrorState.last_resolution_failure_at = new Date().toISOString();
    mirrorState.last_resolution_failure_reason = reason;
    writeMirrorStateDebounced();
  }

  function resolveSessionForTerminal(t: vscode.Terminal): string | null {
    /* Only positive resolutions are cached. Caching a null would
     * permanently shadow a session that the daemon discovers later
     * (the deck tray app starting up after the terminal opened, or
     * the daemon's mtime fallback catching up after the session's
     * first jsonl write). The Stream Deck readdir is one syscall
     * and the cache lookup is in-memory, so retrying on every flush
     * (debounced ~16ms) costs nothing. */
    const cached = sessionIdCache.get(t);
    if (cached) return cached;
    let cwd: string | undefined;
    const opts = t.creationOptions as { cwd?: vscode.Uri | string };
    if (opts.cwd instanceof vscode.Uri) cwd = opts.cwd.fsPath;
    else if (typeof opts.cwd === 'string') cwd = opts.cwd;
    if (!cwd) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      cwd = ws;
    }
    if (!cwd) {
      recordResolutionFailure('terminal has no cwd and no workspace folder');
      return null;
    }
    const wantA = normalizePath(cwd);
    /* Pass 1: Stream Deck identity dir. Fastest and most precise
     * source when the tray app is running. */
    const identityDir = path.posix.join(localAppData(), 'stream-deck', 'identity');
    let identityDirReadable = false;
    let identityPresent = false;
    try {
      const entries = fs.readdirSync(identityDir);
      identityDirReadable = true;
      for (const f of entries) {
        if (!f.endsWith('.json')) continue;
        identityPresent = true;
        try {
          const raw = fs.readFileSync(path.posix.join(identityDir, f), 'utf-8');
          const obj = JSON.parse(raw) as { Cwd?: string };
          const wantB = normalizePath(obj.Cwd ?? '');
          if (!wantB) continue;
          if (
            wantA === wantB ||
            wantA.startsWith(`${wantB}/`) ||
            wantB.startsWith(`${wantA}/`)
          ) {
            const id = f.slice(0, -'.json'.length);
            sessionIdCache.set(t, id);
            return id;
          }
        } catch {
          continue;
        }
      }
    } catch {
      /* identityDirReadable stays false; fall through to daemon
       * fallback rather than failing outright. */
    }
    /* Pass 2: ancestor-walk against the daemon /sessions cache.
     * For every prefix of the terminal cwd from the leaf up to the
     * drive root, encode it to a project_slug and look it up. First
     * active match wins. Covers terminals opened in subdirectories
     * of the project root, and the entire scenario where the deck
     * tray app is not running (the daemon's /sessions endpoint
     * falls back to mtime-based liveness on its own when the deck
     * identity dir is missing or empty). */
    const segments = wantA.split('/').filter((s) => s.length > 0);
    const isAbsolute = wantA.startsWith('/');
    for (let i = segments.length; i >= 1; i--) {
      const ancestor = (isAbsolute ? '/' : '') + segments.slice(0, i).join('/');
      const slug = cwdToSlug(ancestor).toLowerCase();
      const match = daemonActiveSessions.get(slug);
      if (match) {
        sessionIdCache.set(t, match);
        return match;
      }
    }
    /* Both passes missed. Record the most useful failure message we
     * can derive without making a runtime decision the user can act
     * on look pretty. Do NOT cache the miss; next flush retries. */
    let reason: string;
    if (!identityDirReadable) {
      reason = `StreamDeck.App identity dir missing and daemon /sessions has no active session for cwd ${wantA} or any ancestor`;
    } else if (!identityPresent) {
      reason = `StreamDeck.App identity dir empty and daemon /sessions has no active session for cwd ${wantA} or any ancestor`;
    } else {
      reason = `no identity file matches cwd ${wantA} and daemon /sessions has no active session for it or any ancestor`;
    }
    recordResolutionFailure(reason);
    return null;
  }

  function flush(t: vscode.Terminal): void {
    const data = buffers.get(t);
    flushTimers.delete(t);
    buffers.delete(t);
    if (!data) return;
    const sessionId = resolveSessionForTerminal(t);
    if (!sessionId) return;
    /* Source terminal grid dimensions. Without this the mirror's xterm
     * renders at whatever the dashboard container fits, but the cursor
     * positioning ANSI sequences emitted by Claude Code assume the
     * source terminal's cols/rows. The mismatch produced the
     * "scrunched and weird" wrapping. We forward both sides of the
     * envelope so the mirror can resize its grid to match. */
    const dims = (t as { dimensions?: { columns: number; rows: number } })
      .dimensions;
    const dataRoot = getDataRoot();
    const port = (() => {
      const m = dataRoot.match(/skill-connections/);
      return m ? 3747 : 3747;
    })();
    const url = `http://127.0.0.1:${port}/sessions/${encodeURIComponent(
      sessionId,
    )}/terminal-stream`;
    const body: { data: string; cols?: number; rows?: number } = { data };
    if (dims && dims.columns > 0 && dims.rows > 0) {
      body.cols = dims.columns;
      body.rows = dims.rows;
    }
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(() => {
        mirrorState.last_flush_at = new Date().toISOString();
        mirrorState.last_flush_session_id = sessionId;
        mirrorState.last_flush_bytes = data.length;
        mirrorState.last_post_error = null;
        mirrorState.last_post_error_at = null;
        writeMirrorStateDebounced();
      })
      .catch((err) => {
        mirrorState.last_post_error = (err as Error)?.message ?? String(err);
        mirrorState.last_post_error_at = new Date().toISOString();
        writeMirrorStateDebounced();
      });
  }

  /* Attach to a single shell execution and pump its raw output into the
   * same per-terminal buffer/flush pipeline the old onDidWriteTerminalData
   * handler used, so the downstream (resolveSessionForTerminal + POST to
   * /sessions/:id/terminal-stream + mirrorState flush fields) is
   * unchanged. read() MUST be called immediately -- its stream only
   * carries data written after the first read() -- so this runs with no
   * awaits before the read() call. */
  async function streamExecution(
    t: vscode.Terminal,
    execution: vscode.TerminalShellExecution,
  ): Promise<void> {
    let stream: AsyncIterable<string>;
    try {
      stream = execution.read();
    } catch (err) {
      channel.appendLine(
        `[mirror] execution.read() failed: ${(err as Error)?.message ?? String(err)}`,
      );
      return;
    }
    execCount.set(t, (execCount.get(t) ?? 0) + 1);
    updateTracked();
    try {
      for await (const data of stream) {
        if (!data) continue;
        const prev = buffers.get(t) ?? '';
        buffers.set(t, prev + data);
        if (!flushTimers.has(t)) {
          flushTimers.set(t, setTimeout(() => flush(t), 16));
        }
      }
    } catch {
      /* Stream aborted (terminal closed / command killed mid-run). Fall
       * through to the final flush + refcount cleanup below. */
    } finally {
      flush(t);
      const n = (execCount.get(t) ?? 1) - 1;
      if (n <= 0) execCount.delete(t);
      else execCount.set(t, n);
      updateTracked();
    }
  }

  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((e) => {
      try {
        const cmd = (e.execution.commandLine?.value ?? '').toLowerCase();
        const pattern = getTerminalPattern();
        if (pattern && cmd.includes(pattern)) {
          /* Fast path: the launched command IS claude (or matches the
           * configured pattern). Attach synchronously so read() catches
           * the TUI's first full-screen paint with no snapshot delay. */
          void streamExecution(e.terminal, e.execution);
          return;
        }
        /* Slow path: command line did not match (alias/wrapper launch,
         * or low-confidence shell-integration command detection).
         * Confirm the terminal hosts claude via the process-tree probe,
         * then late-attach. We miss the first frames, but claude's TUI
         * emits full repaints, so the next redraw restores a complete
         * frame. */
        void isClaudeTerminal(e.terminal)
          .then((ok) => {
            if (ok) void streamExecution(e.terminal, e.execution);
          })
          .catch(() => undefined);
      } catch {
        /* event handler must never throw */
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      sessionIdCache.delete(t);
      const timer = flushTimers.get(t);
      if (timer) clearTimeout(timer);
      flushTimers.delete(t);
      buffers.delete(t);
      execCount.delete(t);
      updateTracked();
    }),
  );

  /* Kick off the daemon /sessions cache refresh loop. First call is
   * immediate so the cache is populated before the first flush; the
   * interval keeps it fresh as sessions come and go. */
  void refreshDaemonSessions();
  if (daemonSessionsRefreshTimer) clearInterval(daemonSessionsRefreshTimer);
  daemonSessionsRefreshTimer = setInterval(() => {
    void refreshDaemonSessions();
  }, 3000);
  context.subscriptions.push({
    dispose: () => {
      if (daemonSessionsRefreshTimer) {
        clearInterval(daemonSessionsRefreshTimer);
        daemonSessionsRefreshTimer = undefined;
      }
    },
  });

  mirrorState.subscribed = true;
  mirrorState.reason = null;
  writeMirrorStateDebounced();
  channel.appendLine(
    '[mirror] shell-execution capture active (onDidStartTerminalShellExecution + read())',
  );
}

export function activate(context: vscode.ExtensionContext): void {
  channel.appendLine(`[activate] DevNeural Bridge ${getDataRoot()}`);
  presenceContext = context;
  if (isEnabled()) {
    startWatching();
  }

  /* Drop our presence file on deactivate so the daemon doesn't wait
   * out the freshness window to mark the anchor dormant. */
  context.subscriptions.push({ dispose: () => clearPresence() });

  context.subscriptions.push(
    vscode.commands.registerCommand('devneural.bridge.status', () => {
      const status = {
        enabled,
        configEnabled: isEnabled(),
        dataRoot: getDataRoot(),
        bridgeDir: getBridgeDir(),
        terminalPattern: getTerminalPattern(),
        terminals: vscode.window.terminals.map((t) => t.name),
        workspaces: (vscode.workspace.workspaceFolders ?? []).map((f) =>
          f.uri.fsPath,
        ),
        watching: Boolean(watchTimer),
        offsetsTracked: lastOffsets.size,
      };
      channel.show(true);
      channel.appendLine(`[status] ${JSON.stringify(status, null, 2)}`);
      void vscode.window.showInformationMessage(
        `DevNeural Bridge: ${enabled ? 'on' : 'off'}, watching ${getBridgeDir()}`,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('devneural.bridge.toggle', () => {
      enabled = !enabled;
      if (enabled) {
        startWatching();
        void vscode.window.showInformationMessage('DevNeural Bridge: enabled');
      } else {
        stopWatching();
        void vscode.window.showInformationMessage('DevNeural Bridge: paused');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'devneural.bridge.openClaudeTerminal',
      async () => {
        const t = await vscode.window.showQuickPick(
          vscode.window.terminals.map((term) => term.name),
          { placeHolder: 'Pick the terminal that hosts Claude Code' },
        );
        if (!t) return;
        const cfg = vscode.workspace.getConfiguration('devneural.bridge');
        await cfg.update(
          'terminalNamePattern',
          t.toLowerCase(),
          vscode.ConfigurationTarget.Workspace,
        );
        void vscode.window.showInformationMessage(
          `Bridge will route prompts to "${t}".`,
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devneural.bridge')) {
        // Reset offset tracking on dataRoot change
        if (e.affectsConfiguration('devneural.bridge.dataRoot')) {
          lastOffsets = new Map();
        }
        if (!isEnabled()) stopWatching();
        else startWatching();
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(() => clearClaudeTerminalCache()),
    vscode.window.onDidCloseTerminal(() => clearClaudeTerminalCache()),
  );

  context.subscriptions.push({
    dispose: () => stopWatching(),
  });

  // Terminal-output mirror. Wrapped in try/catch so a missing proposed
  // API or any subscription failure can't break the existing prompt
  // delivery flow.
  try {
    startTerminalMirror(context);
  } catch (err) {
    channel.appendLine(
      `[mirror] startup failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

export function deactivate(): void {
  stopWatching();
  /* Drop the sticky cc_session_id latch so a re-activate (window
   * reload, extension upgrade) starts clean and rediscovers the
   * current jsonl rather than reusing an entry that may now point
   * at a closed session. */
  ccSessionLatch.clear();
  channel.appendLine('[deactivate]');
}
