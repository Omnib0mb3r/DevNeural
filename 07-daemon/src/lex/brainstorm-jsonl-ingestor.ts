/**
 * Brainstorm CC-jsonl ingestor.
 *
 * Single source of truth for landing every brainstorm turn into
 * brainstorm_chunks regardless of input modality. The voice WS path
 * historically inserted user turns from the whisper transcript and
 * assistant turns from its own jsonl tail watcher, but text-mode
 * conversations (typed in the Lex textarea) never opened the voice
 * WS, so neither user inputs nor Lex replies landed in chunks. The
 * persisted transcript artifact was voice-only.
 *
 * This module walks every active brainstorm session's CC jsonl from
 * a per-session byte offset and inserts a brainstorm_chunk row for
 * each new user or assistant message. The chunk id is the CC turn
 * uuid; brainstorm_chunks.id is the primary key with INSERT OR
 * REPLACE semantics, so the same row land cleanly even when both
 * the voice WS path and this ingestor write it. Voice + typed
 * turns end up in the same table with proper turn ordering
 * (jsonl write order) and speaker tagging (user vs lex).
 *
 * Lifecycle: setInterval tick in daemon bootstrap, ~5s cadence.
 * Per-brainstorm offset is in-memory only; on daemon restart we
 * re-walk every active brainstorm from byte 0. The deterministic
 * id makes that idempotent (INSERT OR REPLACE) at the cost of
 * one expensive first tick per restart. For multi-MB transcripts
 * that is still cheap relative to the existing distillation reads.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IndexDb, BrainstormSessionRow } from '../store/index-db.js';

/* CC jsonl entry shape we care about. Other fields (tool calls,
 * meta, etc) are ignored. */
interface JsonlEntry {
  type?: string;
  uuid?: string;
  message?: {
    role?: string;
    content?:
      | string
      | Array<{ type?: string; text?: string }>;
  };
  isCompactSummary?: boolean;
  isMeta?: boolean;
}

export interface BrainstormJsonlIngestorDeps {
  db: IndexDb;
  /** Returns brainstorm rows whose jsonl should be tailed. Defaults
   * to db.listBrainstorms({ status: 'active' }). */
  listActiveBrainstorms?: () => BrainstormSessionRow[];
  /** Resolve a brainstorm row to the on-disk CC jsonl path. Tests
   * stub this; production walks ~/.claude/projects. */
  resolveJsonlPath?: (row: BrainstormSessionRow) => string | null;
  /** Bounded read for a jsonl file. Returns the slice from byte
   * offset to end-of-file as a UTF-8 string, plus the new offset.
   * Returns null when the file is missing or unreadable. */
  readSince?: (
    file: string,
    offset: number,
  ) => { text: string; newOffset: number } | null;
  log?: (msg: string) => void;
}

export interface BrainstormJsonlIngestorTickResult {
  scanned: number;
  inserted: number;
  errors: string[];
}

/* Persistent per-process offset map. Tests inject a fresh instance
 * via _resetOffsetsForTests; production callers reuse the module
 * default so daemon hot paths do not re-walk multi-MB jsonls every
 * tick. */
const offsets = new Map<string, number>();

export function _resetBrainstormOffsetsForTests(): void {
  offsets.clear();
}

export function _peekBrainstormOffsetsForTests(): Map<string, number> {
  return new Map(offsets);
}

function defaultResolveJsonlPath(
  row: BrainstormSessionRow,
): string | null {
  if (!row.claude_session_id) return null;
  /* CC layout: ~/.claude/projects/<slug>/<session_id>.jsonl. The
   * slug encodes the worker cwd with separators replaced by `-`.
   * Match the existing voice-ws findJsonlBySessionId resolution by
   * scanning the projects root for a directory that contains the
   * matching jsonl file. Saves us from having to keep two slug
   * encoders in sync. */
  const root = path.posix.join(
    os.homedir().replace(/\\/g, '/'),
    '.claude',
    'projects',
  );
  if (!fs.existsSync(root)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.posix.join(
      root,
      e.name,
      `${row.claude_session_id}.jsonl`,
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function defaultReadSince(
  file: string,
  offset: number,
): { text: string; newOffset: number } | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.size <= offset) {
    return { text: '', newOffset: offset };
  }
  /* Bounded read: cap a single tick at 4 MB so a brand-new daemon
   * boot does not stall the event loop reading a multi-GB log.
   * Subsequent ticks pick up where this one left off. */
  const cap = 4 * 1024 * 1024;
  const end = Math.min(stat.size, offset + cap);
  const length = end - offset;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }
  return { text: buf.toString('utf-8'), newOffset: end };
}

function extractText(content: JsonlEntry['message']): string {
  const c = content?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    let out = '';
    for (const part of c) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        out += (out ? '\n' : '') + part.text;
      }
    }
    return out.trim();
  }
  return '';
}

function normalisedMode(
  raw: string | undefined,
): 'conversation' | 'notes' | 'push-to-talk' {
  if (raw === 'notes' || raw === 'push-to-talk') return raw;
  return 'conversation';
}

export function runBrainstormJsonlIngestTick(
  deps: BrainstormJsonlIngestorDeps,
): BrainstormJsonlIngestorTickResult {
  const list =
    deps.listActiveBrainstorms ??
    (() => deps.db.listBrainstorms({ status: 'active', limit: 200 }));
  const resolve = deps.resolveJsonlPath ?? defaultResolveJsonlPath;
  const readSince = deps.readSince ?? defaultReadSince;
  const errors: string[] = [];
  let inserted = 0;
  let scanned = 0;
  for (const row of list()) {
    scanned += 1;
    const jsonl = resolve(row);
    if (!jsonl) continue;
    const offset = offsets.get(row.id) ?? 0;
    const slice = readSince(jsonl, offset);
    if (!slice) continue;
    /* Walk lines. The slice may end mid-line if the cap fired or the
     * file was being written when we read it; track the last newline
     * we saw and rewind the new offset to that point so we do not
     * lose the trailing partial entry on the next tick. */
    const text = slice.text;
    let lastComplete = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) !== 10) continue;
      const line = text.slice(lastComplete, i);
      lastComplete = i + 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: JsonlEntry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (entry.isCompactSummary || entry.isMeta) continue;
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const uuid = typeof entry.uuid === 'string' ? entry.uuid : null;
      if (!uuid) continue;
      const turnText = extractText(entry.message);
      if (!turnText) continue;
      const role: 'user' | 'lex' = entry.type === 'assistant' ? 'lex' : 'user';
      try {
        deps.db.insertBrainstormChunk({
          id: uuid,
          brainstorm_id: row.id,
          turn_index: deps.db.nextTurnIndex(row.id),
          role,
          mode: normalisedMode(row.mode),
          text: turnText,
          model_id: role === 'lex' ? (process.env.DEVNEURAL_LEX_MODEL_ID ?? 'claude') : '',
          no_decay: 1,
        });
        inserted += 1;
      } catch (err) {
        errors.push(
          `${row.id}@${uuid}: ${(err as Error).message}`,
        );
      }
    }
    const completedBytes = Buffer.byteLength(
      text.slice(0, lastComplete),
      'utf-8',
    );
    offsets.set(row.id, offset + completedBytes);
  }
  if (deps.log && (inserted > 0 || errors.length > 0)) {
    deps.log(
      `[brainstorm-jsonl-ingestor] scanned=${scanned} inserted=${inserted} errors=${errors.length}`,
    );
  }
  return { scanned, inserted, errors };
}

export interface BrainstormJsonlIngestorHandle {
  stop(): void;
  tickNow(): BrainstormJsonlIngestorTickResult;
}

export interface StartIngestorOptions {
  deps: BrainstormJsonlIngestorDeps;
  intervalMs?: number;
  scheduler?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

export const DEFAULT_INGESTOR_INTERVAL_MS = 5_000;

export function startBrainstormJsonlIngestor(
  opts: StartIngestorOptions,
): BrainstormJsonlIngestorHandle {
  const envInterval = Number(process.env.DEVNEURAL_BRAINSTORM_INGEST_INTERVAL_MS);
  const interval =
    opts.intervalMs ??
    (Number.isFinite(envInterval) && envInterval > 0
      ? envInterval
      : DEFAULT_INGESTOR_INTERVAL_MS);
  const sched =
    opts.scheduler ?? {
      set: (fn, ms) => setInterval(fn, ms),
      clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  let inFlight = false;
  const tick = (): BrainstormJsonlIngestorTickResult => {
    if (inFlight) return { scanned: 0, inserted: 0, errors: [] };
    inFlight = true;
    try {
      return runBrainstormJsonlIngestTick(opts.deps);
    } catch (err) {
      opts.deps.log?.(
        `[brainstorm-jsonl-ingestor] tick failed: ${(err as Error).message}`,
      );
      return { scanned: 0, inserted: 0, errors: [(err as Error).message] };
    } finally {
      inFlight = false;
    }
  };
  const handle = sched.set(() => {
    tick();
  }, interval);
  if (typeof (handle as { unref?: () => void }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }
  return {
    stop: () => sched.clear(handle),
    tickNow: tick,
  };
}
