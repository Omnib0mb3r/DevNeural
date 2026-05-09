/**
 * Dashboard session endpoints.
 *
 * Lists active Claude sessions on the host (by reading
 * ~/.claude/projects/<slug>/<session-id>.jsonl), exposes per-session
 * details (current task, rolling summary, recent transcript chunks),
 * and accepts a queued prompt for the session bridge (Phase 3.3).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DATA_ROOT, ensureDir } from '../paths.js';
import { readSummary, readCurrentTask } from '../curation/index.js';
import { getPhase } from './session-phase.js';
import { getPending, type PendingPrompt } from './pending-prompt.js';
import { isSuperseded, markSuperseded } from './superseded.js';
import { getBrainstormByClaudeSessionId } from '../lex/brainstorm-store.js';

const SESSIONS_ROOT = path
  .join(os.homedir(), '.claude', 'projects')
  .replace(/\\/g, '/');
const BRIDGE_DIR = path.posix.join(DATA_ROOT, 'session-bridge');
/* "Active" used to be a heuristic on jsonl mtime. mtime lies: a session
 * gets a final write on /clear, on hook fires from another shell that
 * accidentally references the same id, etc. The truth lives in the
 * StreamDeck.App identity directory: one file per session whose host
 * process the deck app considers alive. We read that set and use it as
 * the authoritative liveness signal.
 *
 * The deck app isn't required, though. When the identity directory
 * doesn't exist, fall back to a generous mtime window so users who
 * never installed the deck still see their sessions. */
/* Mtime-fallback freshness window. Used when the StreamDeck.App identity
 * dir is missing/empty so the daemon falls back to jsonl mtime. Keep
 * short — 24h was wide enough that any session opened in the last day
 * showed as "active" forever, including post-mortem zombies the deck
 * never cleaned. 30min covers a normal typing pause; longer gaps mean
 * the user actually walked away. */
const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000;
/* Identity-file freshness window. StreamDeck.App's CleanStaleFiles uses
 * a 1h identity-mtime threshold (or VS-Code-window match) to decide
 * dead-vs-alive, but it only runs at app startup, not on the periodic
 * 60s sweep. Until that ships, the daemon applies its own gate so an
 * orphaned identity file from a session whose host died ungracefully
 * doesn't paint a phantom-active tile until the deck app restarts. */
const IDENTITY_FRESH_MS = 60 * 60 * 1000;
const STREAMDECK_IDENTITY_DIR = (() => {
  const localAppData =
    process.env.LOCALAPPDATA ??
    path.posix.join(os.homedir().replace(/\\/g, '/'), 'AppData', 'Local');
  return path.posix.join(
    localAppData.replace(/\\/g, '/'),
    'stream-deck',
    'identity',
  );
})();

function readLiveSessionIds(): Set<string> | null {
  if (!fs.existsSync(STREAMDECK_IDENTITY_DIR)) return null;
  try {
    const ids = new Set<string>();
    const now = Date.now();
    for (const e of fs.readdirSync(STREAMDECK_IDENTITY_DIR)) {
      if (!e.endsWith('.json')) continue;
      const sid = e.slice(0, -'.json'.length);
      try {
        const stat = fs.statSync(
          path.posix.join(STREAMDECK_IDENTITY_DIR, e),
        );
        if (now - stat.mtimeMs > IDENTITY_FRESH_MS) continue;
      } catch {
        continue;
      }
      ids.add(sid);
    }
    /* Empty set means the deck tray app is running but has not (yet)
     * registered any session for this boot. Treat the same as "deck
     * not running" so the mtime fallback kicks in instead of marking
     * every session inactive. Otherwise a daemon-restart-before-deck-
     * registers race makes the entire sessions list show inactive
     * even though jsonls are being appended live. */
    if (ids.size === 0) return null;
    return ids;
  } catch {
    return null;
  }
}

export interface SessionListItem {
  session_id: string;
  project_slug: string;
  jsonl_path: string;
  bytes: number;
  last_modified_ms: number;
  active: boolean;
  has_summary: boolean;
  has_task: boolean;
  /** Live state from hook events; used by Stream Deck tile coloring.
   * 'unknown' means no hook has fired yet for this session in this
   * daemon's lifetime (e.g. stale jsonl from before the daemon started). */
  phase: 'thinking' | 'tool' | 'permission' | 'idle' | 'unknown';
  /** Captured Notification message when Claude is waiting for an answer.
   * The dashboard renders this with answer buttons so the user can reply
   * remotely instead of tabbing to the VS Code window. */
  pending_prompt: PendingPrompt | null;
  /** Context-window usage derived from the most recent assistant turn's
   * usage object. Lets the dashboard show a fill bar so the user knows
   * when to /clear or /compact. Null when no usage record yet. */
  context: { tokens: number; max: number } | null;
  /** User-set label from the brainstorm sessions table, joined by
   * claude_session_id. Null for non-Lex sessions and Lex sessions with
   * no rename applied. Stream Deck tiles prefer this over the project
   * slug so renames in the Past Sessions list propagate to the deck. */
  user_label: string | null;
  /** LLM-derived label from the brainstorm sessions table. Same join
   * key as user_label. Used as the second-tier fallback before the
   * project slug. */
  derived_label: string | null;
}

/* Derive current phase by reading the last few KB of the jsonl. The
 * chokidar transcript-watcher fires unreliably on Windows for files
 * that are being appended-to live, leaving phase stuck at 'unknown'
 * for active sessions. Tailing the file on every /sessions request is
 * cheap (~8KB read, only for active sessions) and reflects ground
 * truth: the last record tells us whether Claude is thinking, running
 * a tool, or idle. */
/* Context-window usage from the tail of a session jsonl.
 *
 * Each assistant turn carries a usage object with input_tokens (new
 * input this request), cache_creation_input_tokens (new cache writes),
 * cache_read_input_tokens (cache hits), and output_tokens. The total
 * tokens sent to the model for the most recent turn is the sum of the
 * three input variants — that's the number we want to compare against
 * the model's context window so the user knows when to /clear or
 * /compact.
 *
 * Picking a context limit: jsonl entries record the model name (e.g.
 * "claude-opus-4-7") but not the 1M extension flag. We fall back to
 * the DEVNEURAL_CONTEXT_MAX env var (default 1_000_000 since the user
 * runs Opus with 1M context) so this stays correct without per-message
 * model lookups. */
const CONTEXT_MAX = (() => {
  const raw = process.env.DEVNEURAL_CONTEXT_MAX;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000_000;
})();

interface UsageSnapshot {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

function deriveContextFromTail(
  file: string,
): { tokens: number; max: number } | null {
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return null;
    const tailLen = Math.min(stat.size, 32 * 1024);
    const start = stat.size - tailLen;
    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(tailLen);
      fs.readSync(fd, buf, 0, tailLen, start);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"usage"')) continue;
      try {
        const rec = JSON.parse(line) as {
          message?: { usage?: UsageSnapshot };
        };
        const u = rec.message?.usage;
        if (!u || typeof u.input_tokens !== 'number') continue;
        const tokens =
          (u.input_tokens || 0) +
          (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0);
        return { tokens, max: CONTEXT_MAX };
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function derivePhaseFromTail(file: string): 'thinking' | 'tool' | 'idle' | 'unknown' {
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return 'unknown';
    const tailLen = Math.min(stat.size, 16 * 1024);
    const start = stat.size - tailLen;
    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(tailLen);
      fs.readSync(fd, buf, 0, tailLen, start);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      try {
        const rec = JSON.parse(line) as {
          type?: string;
          role?: string;
          message?: { role?: string; content?: unknown };
        };
        const role = rec.type ?? rec.role ?? rec.message?.role;
        if (role === 'user') return 'thinking';
        if (role === 'assistant') {
          if (/"type"\s*:\s*"tool_use"/.test(line)) return 'tool';
          return 'idle';
        }
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}

/* Read the most recent assistant TEXT message from the tail of a jsonl.
 * Skips tool_use turns (those are mechanical, not pertinent for the
 * user). Returns null if nothing useful is found. Cheap tail scan
 * (~16KB) so it's safe to call on every Stop hook. */
function readLastAssistantText(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (stat.size === 0) return null;
    const tailLen = Math.min(stat.size, 32 * 1024);
    const start = stat.size - tailLen;
    const fd = fs.openSync(file, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(tailLen);
      fs.readSync(fd, buf, 0, tailLen, start);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      try {
        const rec = JSON.parse(line) as {
          type?: string;
          message?: {
            role?: string;
            content?: unknown;
          };
        };
        const role = rec.message?.role;
        if (role !== 'assistant') continue;
        const content = rec.message?.content;
        if (!Array.isArray(content)) continue;
        const textBlocks = content
          .filter(
            (b): b is { type: string; text: string } =>
              b !== null &&
              typeof b === 'object' &&
              (b as { type?: string }).type === 'text' &&
              typeof (b as { text?: string }).text === 'string',
          )
          .map((b) => b.text)
          .filter((t) => t.trim().length > 0);
        if (textBlocks.length === 0) continue;
        return textBlocks.join('\n').trim();
      } catch {
        continue;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/* Build a "Lex pulse" — the dashboard surface for whatever Claude said
 * on the most recent assistant turn. Severity heuristic:
 *   - ends with '?' → warn (Lex has a question for the user)
 *   - >= MIN chars → info (Lex finished a meaningful turn)
 *   - else         → null (trivial reply, skip; we'd rather drop a
 *     small "ok" than spam the rail)
 *
 * Returns the body + severity ready for emitNotification, or null when
 * the turn isn't worth surfacing. */
const LEX_PULSE_MAX = 600;
const LEX_PULSE_MIN = 30;

export function buildLexPulseFromTail(
  sessionId: string,
  cwd: string | undefined,
): { severity: 'info' | 'warn'; title: string; body: string } | null {
  let slugDir: string | null = null;
  if (cwd) {
    const dir = path.posix.join(SESSIONS_ROOT, cwd.replace(/[\\/:]/g, '-'));
    if (fs.existsSync(dir)) slugDir = dir;
  }
  if (!slugDir) {
    // Fallback: scan slugs for the session id.
    const slugs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true });
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const candidate = path.posix.join(
        SESSIONS_ROOT,
        slug.name,
        `${sessionId}.jsonl`,
      );
      if (fs.existsSync(candidate)) {
        slugDir = path.posix.join(SESSIONS_ROOT, slug.name);
        break;
      }
    }
  }
  if (!slugDir) return null;
  const file = path.posix.join(slugDir, `${sessionId}.jsonl`);
  const text = readLastAssistantText(file);
  if (!text) return null;
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const endsWithQuestion = /[?？]\s*$/.test(trimmed);
  // Questions always surface (the user needs to answer). Statements
  // need to clear the min length to avoid spamming the rail with
  // single-word acknowledgements.
  if (!endsWithQuestion && trimmed.length < LEX_PULSE_MIN) return null;
  const body = trimmed.slice(0, LEX_PULSE_MAX);
  return {
    severity: endsWithQuestion ? 'warn' : 'info',
    title: endsWithQuestion ? 'Lex has a question' : 'Lex finished a turn',
    body,
  };
}

/* Encode a cwd into Claude Code's project-slug folder name.
 *
 * CC stores per-workspace transcripts under ~/.claude/projects/<slug>/.
 * The encoding replaces `:`, `\`, and `/` with `-`. e.g.
 *   C:\dev\Projects\DevNeural   ->  C--dev-Projects-DevNeural
 *
 * Deterministic so the daemon can map cwd → slug without scanning the
 * whole projects dir. */
function cwdToSlug(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-');
}

/* Find the previous session in the same workspace as `newSessionId`
 * and mark it superseded. Called by the /sessions/clear-supersede
 * route after the SessionStart hook fires with source=clear.
 *
 * Workspace resolution comes from cwd, encoded into CC's slug folder
 * naming convention. Within that slug we pick the freshest other
 * jsonl whose mtime sits within PROXIMITY_MS of now — that's the
 * /clear or /compact tight-window signature. Anything older gets
 * skipped so legitimate parallel sessions in unrelated workspaces are
 * never retired. */
const PROXIMITY_MS = 5_000;

export function recordClearSupersede(
  newSessionId: string,
  cwd?: string,
): { ok: true; superseded: string | null } | { ok: false; error: string } {
  if (!newSessionId) return { ok: false, error: 'session_id required' };
  if (!fs.existsSync(SESSIONS_ROOT)) {
    return { ok: false, error: 'no claude projects dir' };
  }
  const now = Date.now();
  const candidateSlugs: string[] = [];
  if (cwd) {
    const slug = cwdToSlug(cwd);
    const slugDir = path.posix.join(SESSIONS_ROOT, slug);
    if (fs.existsSync(slugDir)) candidateSlugs.push(slug);
  }
  // Fallback: scan slugs and pick whichever contains the new session's
  // jsonl. Used only if cwd is missing or the encoded slug doesn't
  // exist (CC versions could change the encoding).
  if (candidateSlugs.length === 0) {
    const slugs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true });
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const candidate = path.posix.join(
        SESSIONS_ROOT,
        slug.name,
        `${newSessionId}.jsonl`,
      );
      if (fs.existsSync(candidate)) {
        candidateSlugs.push(slug.name);
        break;
      }
    }
  }
  if (candidateSlugs.length === 0) {
    return { ok: true, superseded: null };
  }
  const slugDir = path.posix.join(SESSIONS_ROOT, candidateSlugs[0]!);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(slugDir, { withFileTypes: true });
  } catch {
    return { ok: false, error: 'readdir failed' };
  }
  let bestId: string | null = null;
  let bestGap = Infinity;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const id = e.name.replace('.jsonl', '');
    if (id === newSessionId) continue;
    try {
      const stat = fs.statSync(path.posix.join(slugDir, e.name));
      const gap = now - stat.mtimeMs;
      if (gap < 0) continue;
      if (gap > PROXIMITY_MS) continue;
      if (gap < bestGap) {
        bestGap = gap;
        bestId = id;
      }
    } catch {
      continue;
    }
  }
  if (bestId) markSuperseded(bestId, newSessionId);
  return { ok: true, superseded: bestId };
}

export function listSessions(): SessionListItem[] {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const out: SessionListItem[] = [];
  const slugs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true });
  const now = Date.now();
  const liveIds = readLiveSessionIds();
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = path.posix.join(SESSIONS_ROOT, slug.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sessionId = e.name.replace('.jsonl', '');
      // Sessions retired by /clear (or /compact) are kept on disk by
      // Claude Code but should not show up as active tiles. The
      // SessionStart hook records them in the superseded store.
      if (isSuperseded(sessionId)) continue;
      const file = path.posix.join(slugDir, e.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      // Authoritative liveness from the deck app's identity dir when
      // available; mtime fallback otherwise.
      const isActive = liveIds
        ? liveIds.has(sessionId)
        : now - stat.mtimeMs < ACTIVE_THRESHOLD_MS;
      // For active sessions, tail-derive phase so the dashboard reflects
      // current reality even when chokidar misses change events. Stale
      // sessions just take whatever the in-memory tracker last knew.
      let phase = getPhase(sessionId);
      if (isActive) {
        const derived = derivePhaseFromTail(file);
        if (derived !== 'unknown') phase = derived;
      }
      const pending = getPending(sessionId);
      // Pending prompt overrides tail-derived phase: if Claude is waiting
      // for an answer, the tile / detail must show 'permission' even
      // though the last jsonl record is still the assistant's question.
      if (pending) phase = 'permission';
      // Optional join with brainstorm_sessions to surface the user's
      // rename onto Stream Deck and Nav tiles. Returns null for any
      // Claude session that was never bound to a Lex brainstorm row.
      const brainstorm = getBrainstormByClaudeSessionId(sessionId);
      out.push({
        session_id: sessionId,
        project_slug: slug.name,
        jsonl_path: file,
        bytes: stat.size,
        last_modified_ms: stat.mtimeMs,
        active: isActive,
        has_summary: Boolean(readSummary(sessionId)),
        has_task: Boolean(readCurrentTask(sessionId)),
        phase,
        pending_prompt: pending,
        context: isActive ? deriveContextFromTail(file) : null,
        user_label: brainstorm?.user_label ?? null,
        derived_label: brainstorm?.derived_label ?? null,
      });
    }
  }
  out.sort((a, b) => b.last_modified_ms - a.last_modified_ms);
  return out;
}

export interface SessionDetail extends SessionListItem {
  summary: string;
  task: string;
  recent_chunks: SessionChunk[];
}

export interface SessionChunk {
  role: string;
  text: string;
  timestamp?: string;
}

export function getSessionDetail(
  sessionId: string,
  options: { recentLimit?: number; query?: string } = {},
): SessionDetail | null {
  const list = listSessions();
  const item = list.find((s) => s.session_id === sessionId);
  if (!item) return null;
  /* If a search query is present we scan the entire jsonl for chunks
   * that match (substring, case-insensitive) and return those plus a
   * little context. Otherwise default to the cheap tail read. The
   * "user opened this session from a search hit" path is exactly when
   * older transcript turns matter. */
  const recent = options.query
    ? readMatchingChunks(item.jsonl_path, options.query, options.recentLimit ?? 200)
    : readRecentChunks(item.jsonl_path, options.recentLimit ?? 30);
  return {
    ...item,
    summary: readSummary(sessionId),
    task: readCurrentTask(sessionId),
    recent_chunks: recent,
  };
}

function readRecentChunks(file: string, limit: number): SessionChunk[] {
  // Read the tail of the jsonl, parse turns, return last N. Bounded so
  // we never load huge transcripts into memory.
  const READ_BYTES = 256 * 1024;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  const start = Math.max(0, stat.size - READ_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf-8');
    // Drop possibly partial first line
    const firstNl = start === 0 ? -1 : text.indexOf('\n');
    const usable = firstNl === -1 ? text : text.slice(firstNl + 1);
    const lines = usable.split('\n').filter((l) => l.trim().length > 0);
    const chunks: SessionChunk[] = [];
    for (const line of lines.slice(-limit * 2)) {
      try {
        const obj = JSON.parse(line) as {
          message?: { role?: string; content?: unknown };
          type?: string;
          timestamp?: string;
          role?: string;
        };
        const role = obj.message?.role ?? obj.role ?? obj.type ?? 'unknown';
        const text = extractText(obj);
        if (!text) continue;
        chunks.push({
          role,
          text: text.slice(0, 2000),
          ...(obj.timestamp ? { timestamp: obj.timestamp } : {}),
        });
      } catch {
        continue;
      }
    }
    return chunks.slice(-limit);
  } finally {
    fs.closeSync(fd);
  }
}

/* Whole-file scan for chunks whose text contains the query
 * (case-insensitive). Used when the user opens a session from a wiki
 * search hit; the matching turn could be anywhere in the transcript,
 * not just the tail. Bounded by MAX_BYTES so a multi-megabyte session
 * doesn't OOM the daemon, and by limit on returned chunks so we never
 * stream a huge payload to the dashboard. */
function readMatchingChunks(file: string, query: string, limit: number): SessionChunk[] {
  const MAX_BYTES = 8 * 1024 * 1024; // 8MB cap per session scan
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  // Read either the whole file or its tail if it exceeds the cap. For
  // most Claude sessions full file is well under 8MB.
  const start = Math.max(0, stat.size - MAX_BYTES);
  const fd = fs.openSync(file, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
  const firstNl = start === 0 ? -1 : text.indexOf('\n');
  const usable = firstNl === -1 ? text : text.slice(firstNl + 1);
  const needle = query.toLowerCase();
  const matches: SessionChunk[] = [];
  for (const line of usable.split('\n')) {
    if (matches.length >= limit) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        message?: { role?: string; content?: unknown };
        type?: string;
        timestamp?: string;
        role?: string;
      };
      const text = extractText(obj);
      if (!text) continue;
      if (!text.toLowerCase().includes(needle)) continue;
      const role = obj.message?.role ?? obj.role ?? obj.type ?? 'unknown';
      matches.push({
        role,
        text: text.slice(0, 4000),
        ...(obj.timestamp ? { timestamp: obj.timestamp } : {}),
      });
    } catch {
      continue;
    }
  }
  return matches;
}

function extractText(obj: { message?: { content?: unknown } }): string {
  const c = obj.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (
          b &&
          typeof b === 'object' &&
          (b as { type?: string }).type === 'text'
        ) {
          return (b as { text?: string }).text ?? '';
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

/* Bridge liveness window. The bridge writes a heartbeat file every
 * tick (~750ms). If the heartbeat is missing or older than this, the
 * dashboard treats the bridge as offline and refuses to queue anything,
 * so messages don't accumulate for hours and then dump all at once
 * when a stale window finally reloads. */
const BRIDGE_HEARTBEAT_FILE = path.posix.join(BRIDGE_DIR, '.heartbeat');
const BRIDGE_HEARTBEAT_STALE_MS = 30_000;

/* Virtual input inbox for the StreamDeck.App tray app. Focus + key
 * actions go here instead of the bridge inbox because the tray app
 * holds standing OS focus rights, where the VS Code extension running
 * inside a browser-spawned process tree does not. The app watches this
 * directory with a FileSystemWatcher and replays the events through
 * the same code path the physical Stream Deck uses. */
const VIRTUAL_INPUT_DIR = (() => {
  const localAppData =
    process.env.LOCALAPPDATA ??
    path.posix.join(os.homedir().replace(/\\/g, '/'), 'AppData', 'Local');
  return path.posix.join(
    localAppData.replace(/\\/g, '/'),
    'stream-deck',
    'virtual-input',
  );
})();

/* Liveness check for the StreamDeck.App. Prefer a dedicated heartbeat
 * file the tray app touches on a 20s interval; fall back to app.log
 * mtime for older builds that don't write a heartbeat. The dedicated
 * file is necessary because app.log only gets written on real events,
 * so a quiet session ages past the freshness window even though the
 * tray is happily running — the daemon was responding 503 "streamdeck
 * app offline" to Nav-mode key dispatches in that case. Falls back to
 * "alive" when neither file exists rather than blocking dashboard
 * actions on a fresh install. */
const STREAMDECK_HEARTBEAT = path.posix.join(VIRTUAL_INPUT_DIR, '..', '.heartbeat');
const STREAMDECK_LOG = path.posix.join(VIRTUAL_INPUT_DIR, '..', 'app.log');
const STREAMDECK_STALE_MS = 60_000;

function streamDeckAlive(): { alive: boolean; ageMs: number | null } {
  for (const file of [STREAMDECK_HEARTBEAT, STREAMDECK_LOG]) {
    try {
      const stat = fs.statSync(file);
      const age = Date.now() - stat.mtimeMs;
      return { alive: age <= STREAMDECK_STALE_MS, ageMs: age };
    } catch {
      continue;
    }
  }
  return { alive: true, ageMs: null };
}

export interface BridgeMirrorState {
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

export interface BridgeStatus {
  alive: boolean;
  last_seen_ms: number | null;
  age_ms: number | null;
  mirror: BridgeMirrorState | null;
}

const BRIDGE_MIRROR_STATE_FILE = path.posix.join(
  BRIDGE_DIR,
  '.mirror-state.json',
);

function readMirrorState(): BridgeMirrorState | null {
  try {
    const raw = fs.readFileSync(BRIDGE_MIRROR_STATE_FILE, 'utf-8');
    return JSON.parse(raw) as BridgeMirrorState;
  } catch {
    return null;
  }
}

export function bridgeStatus(): BridgeStatus {
  try {
    const stat = fs.statSync(BRIDGE_HEARTBEAT_FILE);
    const age = Date.now() - stat.mtimeMs;
    return {
      alive: age <= BRIDGE_HEARTBEAT_STALE_MS,
      last_seen_ms: stat.mtimeMs,
      age_ms: age,
      mirror: readMirrorState(),
    };
  } catch {
    return {
      alive: false,
      last_seen_ms: null,
      age_ms: null,
      mirror: readMirrorState(),
    };
  }
}

/**
 * Queue a prompt for delivery to a running session. The 09-bridge VS
 * Code extension (Phase 3.3) watches this directory and pastes the
 * message into the matching terminal.
 *
 * Refuses to queue if no bridge has written a heartbeat within the
 * stale window. Without this, a closed VS Code window left users with
 * messages silently sitting in the inbox for hours, then all dumping
 * into the terminal when the bridge eventually came back online.
 */
export function queueSessionPrompt(
  sessionId: string,
  text: string,
):
  | { ok: true; queued_at: string }
  | { ok: false; error: string; bridge: BridgeStatus } {
  return writeBridgePrompt(sessionId, text, true);
}

/* "Suggestion" path: the curator (or any other daemon-side voice that
 * wants to nudge the user without claiming the prompt) drops text into
 * Claude's input buffer WITHOUT auto-committing. User reviews, edits,
 * then submits or discards. Same delivery channel as queueSessionPrompt
 * but with commit:false so the bridge skips the trailing Enter. */
export function queueSessionSuggestion(
  sessionId: string,
  text: string,
):
  | { ok: true; queued_at: string }
  | { ok: false; error: string; bridge: BridgeStatus } {
  return writeBridgePrompt(sessionId, text, false);
}

function writeBridgePrompt(
  sessionId: string,
  text: string,
  commit: boolean,
):
  | { ok: true; queued_at: string }
  | { ok: false; error: string; bridge: BridgeStatus } {
  const status = bridgeStatus();
  if (!status.alive) {
    return {
      ok: false,
      error:
        status.last_seen_ms === null
          ? 'bridge offline: no heartbeat ever recorded'
          : `bridge offline: last heartbeat ${Math.round((status.age_ms ?? 0) / 1000)}s ago`,
      bridge: status,
    };
  }
  const queued_at = new Date().toISOString();
  try {
    ensureDir(BRIDGE_DIR);
    const file = path.posix.join(BRIDGE_DIR, `${sessionId}.in`);
    const entry = JSON.stringify({ queued_at, text, commit });
    fs.appendFileSync(file, entry + '\n', 'utf-8');
    return { ok: true, queued_at };
  } catch (err) {
    return {
      ok: false,
      error: `bridge write failed: ${(err as Error).message}`,
      bridge: status,
    };
  }
}

export function queueSessionFocus(
  sessionId: string,
):
  | { ok: true }
  | { ok: false; error: string } {
  return writeVirtualInput(sessionId, { action: 'focus' });
}

export type NavKey =
  | 'up' | 'down' | 'left' | 'right'
  | 'enter' | 'backspace'
  | '1' | '2' | '3' | '4' | '5'
  | 'mic';

const NAV_KEYS: ReadonlySet<NavKey> = new Set([
  'up', 'down', 'left', 'right',
  'enter', 'backspace',
  '1', '2', '3', '4', '5',
  'mic',
]);

export function isNavKey(value: unknown): value is NavKey {
  return typeof value === 'string' && NAV_KEYS.has(value as NavKey);
}

/* Queue a single Nav-mode key press for the bridge to inject into the
 * matching VS Code window. Mirrors the physical Stream Deck Nav layout:
 * arrows for permission picks, numbers for menu options, enter, backspace,
 * mic = Win+H. The bridge file is the same per-session inbox the focus
 * and prompt actions use. */
export function queueSessionKey(
  sessionId: string,
  key: NavKey,
):
  | { ok: true; queued_at: string }
  | { ok: false; error: string } {
  const r = writeVirtualInput(sessionId, { action: 'key', key });
  if (!r.ok) return r;
  return { ok: true, queued_at: r.queued_at };
}

/* Shared writer for the StreamDeck.App's virtual-input inbox. Wraps
 * the appendFileSync call in try/catch so a transient FS failure
 * surfaces as { ok: false, error } instead of throwing through to
 * the request handler. Also checks tray-app liveness so the dashboard
 * can show a real "tray offline" toast instead of the previous
 * always-success path that caused silent drops when the app wasn't
 * running. */
function writeVirtualInput(
  sessionId: string,
  payload: Record<string, unknown>,
): { ok: true; queued_at: string } | { ok: false; error: string } {
  const status = streamDeckAlive();
  if (!status.alive) {
    return {
      ok: false,
      error:
        status.ageMs === null
          ? 'streamdeck app offline: no app.log present'
          : `streamdeck app offline: last log write ${Math.round(status.ageMs / 1000)}s ago`,
    };
  }
  const queued_at = new Date().toISOString();
  try {
    ensureDir(VIRTUAL_INPUT_DIR);
    const file = path.posix.join(VIRTUAL_INPUT_DIR, `${sessionId}.in`);
    fs.appendFileSync(
      file,
      JSON.stringify({ queued_at, ...payload }) + '\n',
      'utf-8',
    );
    return { ok: true, queued_at };
  } catch (err) {
    return {
      ok: false,
      error: `virtual-input write failed: ${(err as Error).message}`,
    };
  }
}
