/**
 * Fallback transcript reader for chunkless brainstorms.
 *
 * The anchor-flat distillation generator normally reads
 * `brainstorm_chunks` rows. Sessions that predate the chunks table
 * (or that ended before any chunks landed) have nothing for that
 * generator to summarise; `runDistillationBackfill` flags them as
 * `skipped` and they never get a `last_summary`. Cold-start preload
 * then shows them as stale forever.
 *
 * This module closes that gap: when chunks are empty, walk the
 * `lex_transcript_ref` rows for the brainstorm and read the underlying
 * CC jsonl files directly. Each line is a JSON event; user and
 * assistant text are extracted and concatenated in chronological order
 * (oldest ref first, oldest line first). The output mimics
 * `buildTranscript`'s shape (`ROLE: text\n...`) so the distillation
 * prompt stays unchanged.
 *
 * The reader is intentionally tolerant of malformed lines: a bad JSON
 * parse, a missing `message`, or an unknown event type is skipped, not
 * thrown. CC jsonl format has shifted over time and these files
 * survived a daemon hang mid-write today.
 */
import * as fs from 'node:fs';
import type { IndexDb, LexTranscriptRefRow } from '../store/index-db.js';

export interface JsonlReaderOptions {
  /** Cap the total transcript size handed to the LLM. Default 8000;
   * matches the chunks-based generator's default so prompt budgets are
   * symmetric. Content beyond the cap is dropped from the head so the
   * newest turns always survive. */
  maxBytes?: number;
  /** Cap the number of lines read per ref. Default 1500. Each line is
   * a CC event; a typical conversation is well under this even after
   * tool spam. */
  maxLinesPerRef?: number;
  /** Test seam: override the disk read. Receives the path, returns the
   * file body or null when the file is unreadable / missing. */
  readFile?: (path: string) => string | null;
  /** Logger for skip diagnostics. Default no-op. */
  log?: (msg: string) => void;
}

interface ExtractedTurn {
  role: 'USER' | 'LEX' | 'TOOL';
  text: string;
}

function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: unknown };
    if (p.type === 'text' && typeof p.text === 'string') {
      parts.push(p.text);
    }
  }
  return parts.join('\n').trim();
}

function extractTurn(line: string): ExtractedTurn | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object') return null;
  const e = event as {
    type?: string;
    message?: { role?: string; content?: unknown };
    isSidechain?: boolean;
  };
  if (e.isSidechain) return null;
  const msg = e.message;
  if (!msg || typeof msg !== 'object') return null;
  const role = msg.role;
  const text = extractTextFromContent(msg.content);
  if (!text) return null;
  if (role === 'user') return { role: 'USER', text };
  if (role === 'assistant') return { role: 'LEX', text };
  return null;
}

/* Automated non-conversation turns that must not seed a fresh Lex.
 *
 * The 2-minute supervision watcher injects a large `[silent supervision
 * tick] Supervise ONLY ...` user turn every cycle, and Lex answers each
 * with a bare "." When those land in the recent-thread tail (cold-start
 * seed) they crowd out the real conversation - a session that spent the
 * night supervising reads back as ten identical tick prompts and empty
 * replies, so the seed teaches Lex nothing about the actual thread.
 * Drop them at the reader: the tick prompts (any bracketed
 * silent/supervision marker) and the empty "." acks that answer them. */
const NOISE_USER_RE = /^\s*\[(?:silent\s+)?(?:supervision|awareness|heartbeat)\b[^\]]*\]/i;
export function isNoiseTurn(role: string, text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (role === 'user' && NOISE_USER_RE.test(t)) return true;
  /* Empty/placeholder assistant acks (the "LEX: ." answer to a tick). */
  if (role !== 'user' && /^[.\s]*$/.test(t)) return true;
  return false;
}

export function readTranscriptFromJsonlRefs(
  db: IndexDb,
  brainstormId: string,
  opts: JsonlReaderOptions = {},
): string {
  const maxBytes = opts.maxBytes ?? 8000;
  const maxLinesPerRef = opts.maxLinesPerRef ?? 1500;
  const readFile = opts.readFile ?? defaultReadFile;
  const log = opts.log ?? (() => undefined);

  let refs: LexTranscriptRefRow[] = [];
  try {
    refs = db.listLexTranscriptRefs(brainstormId);
  } catch (err) {
    log(
      `[jsonl-fallback] listLexTranscriptRefs failed for ${brainstormId.slice(0, 8)}: ${(err as Error).message}`,
    );
    return '';
  }
  if (refs.length === 0) return '';

  const lines: string[] = [];
  for (const ref of refs) {
    if (!ref.transcript_path) continue;
    const body = readFile(ref.transcript_path);
    if (!body) continue;
    const raw = body.split(/\r?\n/);
    const sliceFrom = Math.max(0, raw.length - maxLinesPerRef);
    for (let i = sliceFrom; i < raw.length; i++) {
      const line = raw[i];
      if (!line) continue;
      const turn = extractTurn(line);
      if (!turn) continue;
      if (isNoiseTurn(turn.role, turn.text)) continue;
      const trimmed = turn.text.length > 800 ? turn.text.slice(0, 800) : turn.text;
      lines.push(`${turn.role}: ${trimmed}`);
    }
  }

  if (lines.length === 0) return '';
  const joined = lines.join('\n');
  return joined.length <= maxBytes
    ? joined
    : joined.slice(joined.length - maxBytes);
}

export function hasDistillableJsonlSource(
  db: IndexDb,
  brainstormId: string,
  opts: { existsSync?: (p: string) => boolean } = {},
): boolean {
  const existsSync = opts.existsSync ?? fs.existsSync;
  let refs: LexTranscriptRefRow[] = [];
  try {
    refs = db.listLexTranscriptRefs(brainstormId);
  } catch {
    return false;
  }
  for (const ref of refs) {
    if (ref.transcript_path && existsSync(ref.transcript_path)) return true;
  }
  return false;
}
