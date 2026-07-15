/**
 * Transcript watcher.
 *
 * Watches Claude Code's per-session JSONL transcript files under
 *   ~/.claude/projects/<project-slug>/<session-id>.jsonl
 *
 * Reads incrementally from a persisted byte offset per file. Never
 * loads a full transcript into memory. Each new line is parsed as JSON,
 * scrubbed, and appended into transcripts.jsonl under the matching
 * project-id directory along with a chunk record suitable for later
 * embedding by the daemon brain.
 *
 * P1 scope: capture and persist incremental chunks. Embedding into
 * Chroma happens in P2 once the embedder is wired.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import { resolveProjectIdentity } from '../identity/project-id.js';
import { recordIdentity } from '../identity/registry.js';
import { scrubSecrets } from './secret-scrub.js';
import {
  ensureProjectDir,
  transcriptsFile,
  DATA_ROOT,
} from '../paths.js';
import type { Observation } from '../types.js';
import { appendObservation } from './observations.js';
import type { Store } from '../store/index.js';
import { embedOne } from '../embedder/index.js';
import { setPhase } from '../dashboard/session-phase.js';
import {
  evaluateAssistantReply,
  evaluateCorrection,
} from '../reinforcement/index.js';

const HOME = os.homedir();
const DEFAULT_ROOT = path.join(HOME, '.claude', 'projects').replace(/\\/g, '/');
const OFFSETS_FILE = path.posix.join(DATA_ROOT, 'transcript-offsets.json');

interface OffsetMap {
  [filePath: string]: number;
}

let offsets: OffsetMap = {};
let offsetsLoaded = false;

function loadOffsets(): void {
  if (offsetsLoaded) return;
  offsetsLoaded = true;
  try {
    if (fs.existsSync(OFFSETS_FILE)) {
      offsets = JSON.parse(fs.readFileSync(OFFSETS_FILE, 'utf-8')) as OffsetMap;
    }
  } catch {
    offsets = {};
  }
}

function saveOffsets(): void {
  try {
    fs.writeFileSync(OFFSETS_FILE, JSON.stringify(offsets), 'utf-8');
  } catch {
    /* ignore */
  }
}

interface TranscriptLine {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  cwd?: string;
  sessionId?: string;
  session_id?: string;
  timestamp?: string;
  uuid?: string;
}

function extractCwd(line: TranscriptLine): string | undefined {
  if (typeof line.cwd === 'string') return line.cwd;
  return undefined;
}

function extractSessionId(line: TranscriptLine, fallback: string): string {
  return (
    (typeof line.sessionId === 'string' && line.sessionId) ||
    (typeof line.session_id === 'string' && line.session_id) ||
    fallback
  );
}

function extractText(line: TranscriptLine): string {
  const message = line.message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; text?: string; content?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function classifyRole(line: TranscriptLine): string {
  if (typeof line.role === 'string') return line.role;
  const messageRole = line.message?.role;
  if (typeof messageRole === 'string') return messageRole;
  return line.type ?? 'unknown';
}

async function readTail(file: string): Promise<{
  newBytes: Buffer;
  startOffset: number;
  endOffset: number;
} | null> {
  loadOffsets();
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return null;
  }
  const start = offsets[file] ?? 0;
  if (stat.size <= start) return null;

  const handle = await fsp.open(file, 'r');
  try {
    const length = stat.size - start;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);
    return { newBytes: buffer, startOffset: start, endOffset: stat.size };
  } finally {
    await handle.close();
  }
}

interface ProcessResult {
  chunks: number;
  bytes: number;
}

function chunkId(file: string, uuid: string | undefined, offset: number): string {
  const base = `${file}|${uuid ?? ''}|${offset}`;
  return createHash('sha1').update(base).digest('hex').slice(0, 16);
}

async function processFile(
  file: string,
  store?: Store,
  log?: (msg: string) => void,
  options: { fromOffset?: number } = {},
): Promise<ProcessResult> {
  // Allow callers (backfill) to override the persisted offset and force a
  // re-read from a specific byte. Default behavior reads incrementally.
  if (options.fromOffset !== undefined) {
    loadOffsets();
    offsets[file] = options.fromOffset;
  }
  const tail = await readTail(file);
  if (!tail) return { chunks: 0, bytes: 0 };

  const text = tail.newBytes.toString('utf-8');
  const lines = text.split('\n');
  // Last element may be a partial line; advance offset only past complete lines.
  let consumed = 0;
  let chunkCount = 0;

  let fallbackSession = path.basename(file, '.jsonl');

  /* Turn-bounded chunk accumulator. Per-line writes (transcripts.jsonl,
   * observations, reinforcement signals, dashboard phase) still happen
   * once per jsonl line because those are event-shaped. The vector
   * chunk is what changes: consecutive same-(session, role) lines
   * merge into one embedding so a single thought is one vector
   * instead of being split across 20 vectors at the cost of recall.
   *
   * When (session, role) changes — which is exactly what a turn
   * boundary looks like in a Claude Code jsonl, since tool_use /
   * tool_result blocks share the assistant role with assistant text
   * but the user→assistant→user transitions flush — the open buffer
   * is flushed as one chunk. The end of the batch flushes whatever
   * is still open.
   *
   * Across-batch boundary: if a turn straddles a tail-read (rare,
   * happens when the watcher polls mid-turn) the two halves end up
   * as two adjacent chunks. Acceptable: most turns are visible in
   * one read. The 4000-char embed cap also still applies; very long
   * turns get a single embedding of their first 4000 chars (same as
   * before) but the metadata byte_length tracks the full merged
   * length so retrieval can still surface them. */
  interface TurnBuf {
    sessionId: string;
    role: string;
    projectId: string;
    parts: string[];
    /* Sum of scrubbed-text lengths for the merged chunk so the meta
     * row's byte_length reflects the whole turn, not just the head
     * line. Used by lint/decay heuristics that look at byte_length. */
    byteLengthTotal: number;
    /* uuid + offset of the LAST line that contributed; used to
     * derive the chunk id. Within-turn, the last line's identifiers
     * are stable enough for de-duplication on backfill replay. */
    lastUuid: string | undefined;
    lastOffset: number;
    kind: string;
    tsMs: number;
  }
  let openBuf: TurnBuf | null = null;
  async function flushTurnBuf(): Promise<void> {
    if (!openBuf || !store) {
      openBuf = null;
      return;
    }
    const merged = openBuf.parts.join('\n\n');
    if (!merged.trim()) {
      openBuf = null;
      return;
    }
    const id = chunkId(file, openBuf.lastUuid, openBuf.lastOffset);
    try {
      const vec = await embedOne(merged.slice(0, 4000));
      await store.rawChunks.add({
        id,
        vector: vec,
        metadata: {
          project_id: openBuf.projectId,
          session_id: openBuf.sessionId,
          timestamp_ms: openBuf.tsMs,
          kind: openBuf.kind,
          role: openBuf.role,
          byte_length: openBuf.byteLengthTotal,
          text_preview: merged.slice(0, 200),
        },
      });
      store.db.upsertRawChunk({
        id,
        project_id: openBuf.projectId,
        session_id: openBuf.sessionId,
        timestamp_ms: openBuf.tsMs,
        kind: openBuf.kind,
        role: openBuf.role,
        byte_length: openBuf.byteLengthTotal,
      });
      chunkCount++;
    } catch (err) {
      log?.(
        `[transcript-watcher] embed/store failed: ${(err as Error)?.message ?? err}`,
      );
    }
    openBuf = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i === lines.length - 1 && !text.endsWith('\n')) break;
    consumed += Buffer.byteLength(line, 'utf-8') + 1; // +1 for \n
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue;
    }

    const cwd = extractCwd(parsed) ?? process.cwd();
    const session = extractSessionId(parsed, fallbackSession);
    const role = classifyRole(parsed);
    const rawText = extractText(parsed);
    if (!rawText) continue;
    const scrubbed = scrubSecrets(rawText);
    const identity = resolveProjectIdentity(cwd);
    try {
      recordIdentity(identity);
    } catch {
      /* ignore */
    }
    ensureProjectDir(identity.id);

    const transcriptsPath = transcriptsFile(identity.id);
    const record = {
      timestamp: parsed.timestamp ?? new Date().toISOString(),
      session,
      project_id: identity.id,
      role,
      kind: detectKind(scrubbed, role),
      length: scrubbed.length,
      text: scrubbed,
      source_file: file.replace(/\\/g, '/'),
      uuid: parsed.uuid,
    };
    try {
      fs.appendFileSync(
        transcriptsPath,
        JSON.stringify(record) + '\n',
        'utf-8',
      );
    } catch {
      continue;
    }

    // Mirror a lightweight observation so the daemon can react via signals.
    const obs: Observation = {
      timestamp: record.timestamp,
      event: 'tool_complete',
      session,
      project_id: identity.id,
      project_name: identity.name,
      tool: `transcript:${role}`,
      output: scrubbed.slice(0, 500),
      cwd,
    };
    try {
      appendObservation(identity.id, obs);
    } catch {
      /* ignore */
    }

    // P5: reinforcement signals based on role and pending injection
    if (store) {
      if (role === 'assistant' || record.role === 'assistant') {
        // log passed through so inject-verdict's diagnostics (see
        // reinforcement/index.ts's scheduleInjectVerdict) actually
        // reach the daemon log instead of falling into the no-op default.
        void evaluateAssistantReply(store, session, scrubbed, log).catch(() => undefined);
      } else if (role === 'user' || record.role === 'user') {
        evaluateCorrection(store, session, scrubbed);
      }
    }

    // Drive the dashboard's stream-deck tile phase from the transcript.
    // Tool-use detection runs against the raw JSON line because
    // extractText drops tool_use blocks and the scrubbed text rarely
    // carries the marker. The dashboard's listSessions() also tails
    // the same jsonl on every poll, so this is a "best-effort fast
    // path" for sessions actively producing transcript activity.
    {
      const isToolUse =
        /"type"\s*:\s*"tool_use"/.test(trimmed) ||
        /"tool_use_id"/.test(trimmed);
      if (role === 'user' || record.role === 'user') {
        setPhase(session, 'thinking');
      } else if (role === 'assistant' || record.role === 'assistant') {
        setPhase(session, isToolUse ? 'tool' : 'idle');
      }
    }

    // P2: append into the turn-bounded buffer. Flush triggers on
    // (session, role) transition; flushTurnBuf() at end of batch
    // catches whatever the final lines accumulated.
    if (store) {
      const tsMs = Date.parse(record.timestamp);
      const stableTs = Number.isFinite(tsMs) ? tsMs : Date.now();
      if (
        openBuf &&
        (openBuf.sessionId !== session || openBuf.role !== role)
      ) {
        await flushTurnBuf();
      }
      if (!openBuf) {
        openBuf = {
          sessionId: session,
          role,
          projectId: identity.id,
          parts: [],
          byteLengthTotal: 0,
          lastUuid: parsed.uuid,
          lastOffset: tail.startOffset + consumed,
          kind: record.kind,
          tsMs: stableTs,
        };
      }
      openBuf.parts.push(scrubbed);
      openBuf.byteLengthTotal += scrubbed.length;
      openBuf.lastUuid = parsed.uuid;
      openBuf.lastOffset = tail.startOffset + consumed;
      openBuf.tsMs = stableTs;
      /* Cap merged text so a runaway long turn doesn't push the embed
       * call past its buffer limit silently. We still append for the
       * meta byte_length but stop growing the parts list. */
      if (openBuf.parts.join('\n\n').length > 8000) {
        await flushTurnBuf();
      }
    }
  }

  /* Flush any final turn buffer that was still open at end-of-batch. */
  await flushTurnBuf();
  offsets[file] = tail.startOffset + consumed;
  saveOffsets();
  return { chunks: chunkCount, bytes: consumed };
}

function detectKind(text: string, role: string): string {
  if (text.includes('```') && text.split('\n').length > 6) return 'code-mixed';
  if (role === 'user') return 'user-prose';
  if (role === 'assistant') return 'assistant-prose';
  return 'meta';
}

/** Public re-export so backfill can drive the same parse + embed pipeline
 * the live watcher uses, without duplicating extract / scrub / embed code. */
export async function ingestTranscriptFile(
  file: string,
  store: Store,
  log: (msg: string) => void = () => undefined,
  options: { fromOffset?: number } = {},
): Promise<ProcessResult> {
  return processFile(file.replace(/\\/g, '/'), store, log, options);
}

/** Drop the persisted offset for a file so a future call re-reads it whole. */
export function resetTranscriptOffset(file: string): void {
  loadOffsets();
  delete offsets[file.replace(/\\/g, '/')];
  saveOffsets();
}

export interface TranscriptWatcher {
  stop: () => Promise<void>;
}

export interface WatcherOptions {
  rootDir?: string;
  log?: (msg: string) => void;
  store?: Store;
}

/** Timestamp (ms since epoch) of the last time the live watcher received a
 * jsonl add/change event, or a catch-up pass processed a file. 0 means
 * "never" (fresh process, or watcher hasn't fired yet). Exported read-only
 * via lastTranscriptEventMs() so callers/tests can assert on liveness
 * without reaching into module internals. */
let lastEventMs = 0;

function touchLastEvent(): void {
  lastEventMs = Date.now();
}

/** Test/diagnostic seam: current lastEventMs value. */
export function lastTranscriptEventMs(): number {
  return lastEventMs;
}

/** Fix 34b (mirrored from src/dashboard/worker-event-listener.ts): chokidar
 * v4 removed glob support entirely. Watching `${root}/**\/*.jsonl` as a
 * string binds chokidar to that literal path, which never exists, so the
 * watcher reports 'ready' but no add/change event ever fires for real
 * session files. The fix is to watch the ROOT DIRECTORY and filter to
 * .jsonl files with `ignored`; chokidar recurses into
 * ~/.claude/projects/<slug>/ on its own since directories are never
 * ignored, and non-jsonl files are skipped once stats arrive. This
 * predicate is exported so tests can exercise the filter logic directly
 * without mocking the filesystem watcher. */
export function isIgnoredTranscriptPath(
  filePath: string,
  stats?: fs.Stats,
): boolean {
  if (stats && stats.isFile()) {
    return !filePath.replace(/\\/g, '/').endsWith('.jsonl');
  }
  return false;
}

interface JsonlFileInfo {
  file: string;
  mtimeMs: number;
  size: number;
}

/** List .jsonl files one level below root (root/<slug>/<uuid>.jsonl), which
 * is the only shape Claude Code ever produces under ~/.claude/projects.
 * Used by both the boot catch-up scan and the staleness self-check so
 * there is exactly one place that knows the on-disk layout. */
function listJsonlFiles(root: string): JsonlFileInfo[] {
  const out: JsonlFileInfo[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.posix.join(root, entry.name);
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith('.jsonl')) continue;
      const fp = path.posix.join(dir, child.name);
      try {
        const stat = fs.statSync(fp);
        out.push({ file: fp, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        continue;
      }
    }
  }
  return out;
}

const CATCHUP_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const CATCHUP_LOG_EVERY = 25;

/** One-shot boot catch-up: the watcher was dead (silently, wrong glob) for
 * ~65 days before this fix, so a lot of session jsonl has unprocessed
 * bytes sitting past their persisted offset. Walk the tree once at start,
 * bounded to files touched in the last 90 days, and replay each through
 * the normal processFile path (sequentially, so embedding calls don't
 * pile up). processFile is offset-aware and a no-op if a file has nothing
 * new, so this is safe to run on every boot, not just the first one after
 * the fix lands. */
/** Exported (also used as the boot catch-up seam) so tests can drive the
 * scan directly against a synthetic root dir + offsets state without
 * waiting on the fire-and-forget call inside startTranscriptWatcher. */
export async function runTranscriptCatchupScan(
  root: string,
  store: Store | undefined,
  log: (msg: string) => void,
): Promise<void> {
  loadOffsets();
  const now = Date.now();
  const candidates = listJsonlFiles(root).filter((f) => {
    if (now - f.mtimeMs > CATCHUP_MAX_AGE_MS) return false;
    const cursor = offsets[f.file] ?? 0;
    return f.size > cursor;
  });
  if (candidates.length === 0) {
    log(`[transcript-watcher] catch-up: nothing pending`);
    return;
  }
  log(`[transcript-watcher] catch-up: ${candidates.length} file(s) with unprocessed bytes`);
  let processed = 0;
  let totalChunks = 0;
  let totalBytes = 0;
  for (const candidate of candidates) {
    try {
      const result = await processFile(candidate.file, store, log);
      totalChunks += result.chunks;
      totalBytes += result.bytes;
      touchLastEvent();
    } catch (err) {
      log(
        `[transcript-watcher] catch-up: ${path.basename(candidate.file)} failed: ${(err as Error)?.message ?? err}`,
      );
    }
    processed++;
    if (processed % CATCHUP_LOG_EVERY === 0) {
      log(
        `[transcript-watcher] catch-up progress: ${processed}/${candidates.length} files`,
      );
    }
  }
  log(
    `[transcript-watcher] catch-up done: ${processed}/${candidates.length} files, +${totalChunks} chunks (${totalBytes}B)`,
  );
}

const STALE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 h

/** Cheap liveness self-check so a repeat of "chokidar bound but never
 * fired" is never silent again. If the watcher hasn't processed a single
 * event in 6h AND the filesystem shows a jsonl file whose mtime is newer
 * than that last-processed timestamp (i.e. something happened that we
 * missed), log loudly. A directory scan at 30-minute cadence is cheap
 * relative to the cost of a multi-week silent outage. */
function checkStaleness(root: string, log: (msg: string) => void): void {
  const elapsed = Date.now() - lastEventMs;
  if (elapsed < STALE_THRESHOLD_MS) return;
  const files = listJsonlFiles(root);
  let newestMtime = 0;
  for (const f of files) {
    if (f.mtimeMs > newestMtime) newestMtime = f.mtimeMs;
  }
  if (newestMtime > lastEventMs) {
    log(
      `[transcript-watcher] STALE: fs shows newer jsonl than last processed event ` +
        `(newest_mtime=${new Date(newestMtime).toISOString()}, ` +
        `last_event=${lastEventMs ? new Date(lastEventMs).toISOString() : 'never'}, root=${root})`,
    );
  }
}

export function startTranscriptWatcher(
  options: WatcherOptions = {},
): TranscriptWatcher {
  const root = (options.rootDir ?? DEFAULT_ROOT).replace(/\\/g, '/');
  const log = options.log ?? (() => undefined);
  if (!fs.existsSync(root)) {
    log(`[transcript-watcher] boot: root not present: ${root}, mode=idle`);
    return { stop: async () => undefined };
  }

  log(`[transcript-watcher] boot: root=${root} mode=dir-watch+jsonl-filter (chokidar v4, glob-free)`);

  // Fix 34b (see isIgnoredTranscriptPath doc comment above): watch the
  // root directory itself, not a glob string. depth:1 bounds recursion to
  // root -> <slug>/ -> <uuid>.jsonl, which is the only shape this tree
  // ever takes; deeper traversal would just be wasted watch handles.
  //
  // ignoreInitial:true (matches worker-event-listener.ts's own Fix 34b)
  // is deliberate: the explicit runCatchupScan below owns the boot
  // backlog sequentially and offset-aware. Letting chokidar ALSO fire
  // 'add' for every pre-existing file (ignoreInitial:false) would race
  // that scan -- two concurrent processFile calls on the same fresh file
  // both read from offset 0 before either persists, doubling every
  // transcripts.jsonl line, observation, and reinforcement signal.
  const watcher: FSWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    ignored: isIgnoredTranscriptPath,
    ignorePermissionErrors: true,
  });

  const onChange = (file: string): void => {
    touchLastEvent();
    void processFile(file.replace(/\\/g, '/'), options.store, log).then(
      (result) => {
        if (result.chunks > 0) {
          log(
            `[transcript-watcher] ${path.basename(file)} +${result.chunks} chunks (${result.bytes}B)`,
          );
        }
      },
    );
  };

  watcher.on('add', onChange);
  watcher.on('change', onChange);
  watcher.on('error', (err: unknown) => {
    log(`[transcript-watcher] error: ${(err as Error)?.message ?? err}`);
  });

  log(`[transcript-watcher] watching ${root}`);

  // One-shot backlog drain. Fire-and-forget: the live watcher above is
  // already bound and will pick up anything written while catch-up runs,
  // and processFile's offset tracking makes double-processing harmless.
  void runTranscriptCatchupScan(root, options.store, log).catch((err) => {
    log(`[transcript-watcher] catch-up failed: ${(err as Error)?.message ?? err}`);
  });

  const staleTimer: NodeJS.Timeout = setInterval(() => {
    checkStaleness(root, log);
  }, STALE_CHECK_INTERVAL_MS);

  return {
    stop: async () => {
      clearInterval(staleTimer);
      await watcher.close();
    },
  };
}
