/**
 * One-time backfill of historical Claude Code session transcripts.
 *
 * Runs in two modes:
 *
 *   raw  - Re-walks every ~/.claude/projects/<slug>/<session>.jsonl in the
 *          host home, calls the same processFile pipeline the live
 *          transcript-watcher uses, and embeds every user/assistant turn
 *          into store.rawChunks. Cheap (~5ms/embed). After this completes
 *          /search/all returns hits over your full Claude history.
 *
 *   wiki - Walks the same files but groups each session into one or more
 *          ~8KB content blobs and feeds them to runIngest, producing
 *          distilled wiki pages. Expensive (5-30s/blob through ollama).
 *          Run overnight.
 *
 * Both modes are single-flight per-mode and persist a per-file cursor so
 * a kill mid-run is resumable. State lives in DATA_ROOT/.backfill-{raw|wiki}.json.
 *
 * Driven by /admin/backfill/{raw|wiki} POST endpoints; status streamed via
 * /admin/backfill/status. Dashboard /system tab exposes a button + progress.
 *
 * Why in-process rather than a separate node script: vector store writes
 * are not multi-process safe (atomic rename guards against partial writes,
 * not concurrent writers). Running inside the daemon serialises naturally.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PROJECT_DOC_KIND } from '../store/index.js';
import type { Store } from '../store/index.js';
import { DATA_ROOT } from '../paths.js';
import { ingestTranscriptFile } from '../capture/transcript-watcher.js';
import { runIngest } from './ingest.js';
import { resolveProjectIdentity } from '../identity/project-id.js';
import { recordIdentity } from '../identity/registry.js';
import { embedOne } from '../embedder/index.js';
import { scrubSecrets } from '../capture/secret-scrub.js';

const CLAUDE_PROJECTS_ROOT = path.posix.join(
  os.homedir().replace(/\\/g, '/'),
  '.claude',
  'projects',
);

const RAW_CURSOR_FILE = path.posix.join(DATA_ROOT, '.backfill-raw.json');
const WIKI_CURSOR_FILE = path.posix.join(DATA_ROOT, '.backfill-wiki.json');
const STATUS_FILE = path.posix.join(DATA_ROOT, '.backfill-status.json');

interface RawCursorFile {
  /** Map of jsonl absolute path -> end-byte already processed. */
  files: Record<string, number>;
  last_run_at: string | null;
}

/* Wiki cursor entry. Three shapes:
 *   'done'                        - succeeded; never reprocessed
 *   { attempts, last_error }      - transient failure (validation, parse,
 *                                   transient ollama hiccup). Retried on
 *                                   the next start until attempts hits
 *                                   WIKI_MAX_ATTEMPTS, then abandoned.
 *   'failed' (legacy string)      - written by the older single-shot
 *                                   policy; treated as attempts=1 on load
 *                                   so an old failure gets one retry. */
type WikiFileStatus =
  | 'done'
  | 'failed'
  | { attempts: number; last_error: string };

interface WikiCursorFile {
  files: Record<string, WikiFileStatus>;
  last_run_at: string | null;
}

const WIKI_MAX_ATTEMPTS = Number(process.env.DEVNEURAL_BACKFILL_WIKI_MAX_ATTEMPTS ?? 3);

function isWikiDone(status: WikiFileStatus | undefined): boolean {
  return status === 'done';
}

function shouldSkipWiki(status: WikiFileStatus | undefined): boolean {
  if (status === 'done') return true;
  if (typeof status === 'object' && status.attempts >= WIKI_MAX_ATTEMPTS) return true;
  return false;
}

function bumpFailure(prev: WikiFileStatus | undefined, error: string): WikiFileStatus {
  if (prev === 'done') return 'done';
  if (prev === 'failed' || prev === undefined) {
    // Legacy string 'failed' counts as one prior attempt.
    return { attempts: (prev === 'failed' ? 1 : 0) + 1, last_error: error };
  }
  return { attempts: prev.attempts + 1, last_error: error };
}

export type BackfillMode = 'raw' | 'wiki';

export interface BackfillVerification {
  ok: boolean;
  /** Snippet pulled from a real ingested turn, used as the search query. */
  query_preview: string;
  /** Cosine similarity of the top hit (vectors are L2-normalized in the
   * embedder, so dot product == cosine). */
  top_score: number;
  /** Score below this and we flag it: the embed -> store -> search loop
   * likely broke. >0.5 is conservative; if we just embedded the exact
   * text, an in-corpus hit should be near 1.0. */
  threshold: number;
  /** Preview of the top hit's stored text (first ~120 chars). */
  top_hit_preview: string;
  generated_at: string;
}

export interface BackfillRunStatus {
  mode: BackfillMode;
  running: boolean;
  cancel_requested: boolean;
  started_at: string | null;
  completed_at: string | null;
  files_total: number;
  files_done: number;
  files_skipped: number;
  bytes_processed: number;
  chunks_or_pages: number;
  errors: number;
  last_error: string | null;
  current_file: string | null;
  /** Only populated for raw mode after a successful run. */
  verification: BackfillVerification | null;
}

function emptyStatus(mode: BackfillMode): BackfillRunStatus {
  return {
    mode,
    running: false,
    cancel_requested: false,
    started_at: null,
    completed_at: null,
    files_total: 0,
    files_done: 0,
    files_skipped: 0,
    bytes_processed: 0,
    chunks_or_pages: 0,
    errors: 0,
    last_error: null,
    current_file: null,
    verification: null,
  };
}

/** Persisted status so the dashboard remembers the last run across daemon
 * restarts. Without this, killing the daemon (intentional or not) would
 * make the UI show "never run" even though chunks/pages are still on
 * disk and the cursor knows otherwise. */
function reconstructFromCursor(): Record<BackfillMode, BackfillRunStatus> {
  /* Bootstrap status from cursor files when STATUS_FILE doesn't exist
   * yet (first run after this fix lands). Without this, prior backfills
   * would show "never run" until the user kicks off another pass. */
  const out = { raw: emptyStatus('raw'), wiki: emptyStatus('wiki') };
  try {
    const rawCursor = loadRawCursor();
    const fileCount = Object.keys(rawCursor.files).length;
    if (fileCount > 0) {
      out.raw.files_total = fileCount;
      out.raw.files_done = fileCount;
      out.raw.bytes_processed = Object.values(rawCursor.files).reduce(
        (a, b) => a + b,
        0,
      );
      out.raw.completed_at = rawCursor.last_run_at;
      out.raw.started_at = rawCursor.last_run_at;
    }
  } catch {
    /* ignore */
  }
  try {
    const wikiCursor = loadWikiCursor();
    const fileCount = Object.keys(wikiCursor.files).length;
    if (fileCount > 0) {
      out.wiki.files_total = fileCount;
      out.wiki.files_done = Object.values(wikiCursor.files).filter(
        (v) => v === 'done',
      ).length;
      out.wiki.errors = Object.values(wikiCursor.files).filter(
        (v) => v === 'failed' || (typeof v === 'object' && v.attempts >= WIKI_MAX_ATTEMPTS),
      ).length;
      out.wiki.completed_at = wikiCursor.last_run_at;
      out.wiki.started_at = wikiCursor.last_run_at;
    }
  } catch {
    /* ignore */
  }
  return out;
}

function loadPersistedStatus(): Record<BackfillMode, BackfillRunStatus> {
  if (!fs.existsSync(STATUS_FILE)) return reconstructFromCursor();
  try {
    const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')) as {
      raw?: BackfillRunStatus;
      wiki?: BackfillRunStatus;
    };
    // Anything claimed running at load time is stale (we just restarted).
    // Treat as cancelled so the UI surfaces last error/last completion.
    const sanitize = (s: BackfillRunStatus, mode: BackfillMode): BackfillRunStatus => {
      const out = { ...emptyStatus(mode), ...s, mode };
      if (out.running) {
        out.running = false;
        out.cancel_requested = false;
        out.completed_at = out.completed_at ?? new Date().toISOString();
        out.last_error = out.last_error ?? 'daemon restarted mid-run';
        out.current_file = null;
      }
      return out;
    };
    const fallback = reconstructFromCursor();
    return {
      raw: raw.raw ? sanitize(raw.raw, 'raw') : fallback.raw,
      wiki: raw.wiki ? sanitize(raw.wiki, 'wiki') : fallback.wiki,
    };
  } catch {
    return reconstructFromCursor();
  }
}

function savePersistedStatus(): void {
  try {
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify({ raw: status.raw, wiki: status.wiki }, null, 2),
      'utf-8',
    );
  } catch {
    /* non-fatal */
  }
}

const status: Record<BackfillMode, BackfillRunStatus> = loadPersistedStatus();

/* AbortController per mode so cancel can interrupt the in-flight LLM
 * call (which can take 5-30s through ollama). Without abort, "cancel"
 * just sets a flag and the user waits for the current blob to finish.
 * The controller is replaced on every start. */
const aborters: Record<BackfillMode, AbortController | null> = {
  raw: null,
  wiki: null,
};

export function getBackfillStatus(): { raw: BackfillRunStatus; wiki: BackfillRunStatus } {
  return { raw: { ...status.raw }, wiki: { ...status.wiki } };
}

export function requestBackfillCancel(mode: BackfillMode): void {
  if (status[mode].running) {
    status[mode].cancel_requested = true;
    aborters[mode]?.abort();
    savePersistedStatus();
  }
}

/** Walk ~/.claude/projects recursively, return every .jsonl path. */
function listClaudeJsonl(): string[] {
  if (!fs.existsSync(CLAUDE_PROJECTS_ROOT)) return [];
  const out: string[] = [];
  const slugs = fs.readdirSync(CLAUDE_PROJECTS_ROOT, { withFileTypes: true });
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = path.posix.join(CLAUDE_PROJECTS_ROOT, slug.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      out.push(path.posix.join(slugDir, e.name));
    }
  }
  return out;
}

function loadRawCursor(): RawCursorFile {
  if (!fs.existsSync(RAW_CURSOR_FILE)) {
    return { files: {}, last_run_at: null };
  }
  try {
    return JSON.parse(fs.readFileSync(RAW_CURSOR_FILE, 'utf-8')) as RawCursorFile;
  } catch {
    return { files: {}, last_run_at: null };
  }
}

function saveRawCursor(cursor: RawCursorFile): void {
  fs.writeFileSync(RAW_CURSOR_FILE, JSON.stringify(cursor, null, 2), 'utf-8');
}

function loadWikiCursor(): WikiCursorFile {
  if (!fs.existsSync(WIKI_CURSOR_FILE)) {
    return { files: {}, last_run_at: null };
  }
  try {
    return JSON.parse(fs.readFileSync(WIKI_CURSOR_FILE, 'utf-8')) as WikiCursorFile;
  } catch {
    return { files: {}, last_run_at: null };
  }
}

function saveWikiCursor(cursor: WikiCursorFile): void {
  fs.writeFileSync(WIKI_CURSOR_FILE, JSON.stringify(cursor, null, 2), 'utf-8');
}

/** Sanity check: pull a real turn from one of the processed transcripts,
 * embed it, search store.rawChunks, and verify the top hit comes back at a
 * decent cosine. If we just embedded that exact text into the same store
 * the embed -> persist -> search loop is intact and we can safely go on
 * to the wiki pass. The wiki pass is hours of LLM time; you don't want to
 * discover halfway through that the index never actually grew. */
async function verifyRawSearchable(
  store: Store,
  sampleFile: string | null,
  log: (msg: string) => void,
): Promise<BackfillVerification | null> {
  if (!sampleFile) {
    log('[backfill-raw] verify: no sample file (nothing to test)');
    return null;
  }
  const { turns } = readSessionTurns(sampleFile);
  // Pick a substantial turn so the embedding is informative; fall back to
  // whatever is available if the session is sparse.
  const turn =
    turns.find((t) => t.text.trim().length >= 200) ??
    turns.find((t) => t.text.trim().length >= 60) ??
    turns[0];
  if (!turn) {
    log('[backfill-raw] verify: sample file had no usable turns');
    return null;
  }
  const queryText = scrubSecrets(turn.text.trim()).slice(0, 1500);
  const queryPreview = queryText.replace(/\s+/g, ' ').slice(0, 120);

  const VERIFY_THRESHOLD = 0.5;
  try {
    const vec = await embedOne(queryText);
    /* Verify against transcript chunks only; knowledge-index chunks
     * share the collection but are not what backfill wrote. */
    const hits = store.rawChunks.search(vec, {
      topK: 1,
      filter: (m) => (m as { kind?: string }).kind !== PROJECT_DOC_KIND,
    });
    if (hits.length === 0) {
      log('[backfill-raw] verify FAIL: no hits at all from rawChunks');
      return {
        ok: false,
        query_preview: queryPreview,
        top_score: 0,
        threshold: VERIFY_THRESHOLD,
        top_hit_preview: '',
        generated_at: new Date().toISOString(),
      };
    }
    const top = hits[0]!;
    const meta = top.metadata as { text_preview?: string };
    const verification: BackfillVerification = {
      ok: top.score >= VERIFY_THRESHOLD,
      query_preview: queryPreview,
      top_score: Number(top.score.toFixed(4)),
      threshold: VERIFY_THRESHOLD,
      top_hit_preview: (meta.text_preview ?? '').slice(0, 160),
      generated_at: new Date().toISOString(),
    };
    log(
      `[backfill-raw] verify: top_score=${verification.top_score} (threshold ${VERIFY_THRESHOLD}) ${verification.ok ? 'OK' : 'FAIL'}`,
    );
    return verification;
  } catch (err) {
    log(`[backfill-raw] verify failed: ${(err as Error).message}`);
    return {
      ok: false,
      query_preview: queryPreview,
      top_score: 0,
      threshold: VERIFY_THRESHOLD,
      top_hit_preview: `error: ${(err as Error).message}`,
      generated_at: new Date().toISOString(),
    };
  }
}

/** Backfill raw chunks. Drives the same pipeline as the live watcher per file. */
export async function runBackfillRaw(
  store: Store,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  if (status.raw.running) {
    log('[backfill-raw] already running; skip');
    return;
  }

  const files = listClaudeJsonl();
  const cursor = loadRawCursor();

  status.raw = {
    ...emptyStatus('raw'),
    running: true,
    started_at: new Date().toISOString(),
    files_total: files.length,
  };
  log(`[backfill-raw] start: ${files.length} jsonl files under ${CLAUDE_PROJECTS_ROOT}`);

  try {
    for (const file of files) {
      if (status.raw.cancel_requested) {
        log('[backfill-raw] cancel requested; stopping');
        break;
      }
      status.raw.current_file = file;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        status.raw.files_skipped += 1;
        continue;
      }
      const lastDone = cursor.files[file] ?? 0;
      if (lastDone >= stat.size) {
        status.raw.files_skipped += 1;
        continue;
      }
      try {
        const result = await ingestTranscriptFile(file, store, log, {
          fromOffset: lastDone,
        });
        status.raw.chunks_or_pages += result.chunks;
        status.raw.bytes_processed += result.bytes;
        cursor.files[file] = stat.size;
        cursor.last_run_at = new Date().toISOString();
        // Persist cursor after every file so a kill loses at most one file
        // of progress. Also persist status so the dashboard remembers
        // last-completion across daemon restarts.
        saveRawCursor(cursor);
        status.raw.files_done += 1;
        savePersistedStatus();
        if (status.raw.files_done % 10 === 0) {
          log(
            `[backfill-raw] progress ${status.raw.files_done}/${files.length} files, ${status.raw.chunks_or_pages} chunks`,
          );
        }
      } catch (err) {
        status.raw.errors += 1;
        status.raw.last_error = (err as Error).message;
        log(`[backfill-raw] ${file} failed: ${status.raw.last_error}`);
      }
    }

    // Flush vector store atomically so the new chunks survive a daemon kill.
    try {
      await store.flush();
    } catch (err) {
      log(`[backfill-raw] final flush failed: ${(err as Error).message}`);
    }

    // Post-run verification: confirm the index is queryable end-to-end.
    // Runs whenever any file has a recorded cursor (this run OR a prior
    // run that the cursor file remembers), so a re-click after a daemon
    // restart still re-confirms the embed -> store -> search loop is
    // intact instead of leaving the UI showing "never run".
    if (
      !status.raw.cancel_requested &&
      (status.raw.files_done > 0 || status.raw.files_skipped > 0)
    ) {
      const sample =
        files.find((f) => cursor.files[f] && cursor.files[f]! > 0) ??
        files[files.length - 1] ??
        null;
      status.raw.verification = await verifyRawSearchable(store, sample, log);
    }

    log(
      `[backfill-raw] done: ${status.raw.files_done}/${files.length} files, ${status.raw.chunks_or_pages} chunks, ${status.raw.errors} errors`,
    );
  } finally {
    status.raw.running = false;
    status.raw.completed_at = new Date().toISOString();
    status.raw.current_file = null;
    savePersistedStatus();
  }
}

interface TranscriptLine {
  cwd?: string;
  message?: { role?: string; content?: unknown };
  role?: string;
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
      const b = block as { type?: string; text?: string };
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
  return 'unknown';
}

/** Read a session jsonl in one pass and pull (cwd, role, text) tuples for
 * the human-driven turns. tool/system records and empty content are
 * dropped. */
function readSessionTurns(
  file: string,
): { cwd: string | null; turns: { role: string; text: string }[] } {
  const turns: { role: string; text: string }[] = [];
  let cwd: string | null = null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { cwd, turns };
  }
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (!cwd && typeof parsed.cwd === 'string') cwd = parsed.cwd;
    const role = classifyRole(parsed);
    if (role !== 'user' && role !== 'assistant') continue;
    const text = extractText(parsed).trim();
    if (!text) continue;
    turns.push({ role, text });
  }
  return { cwd, turns };
}

const WIKI_BLOB_BYTES = Number(process.env.DEVNEURAL_BACKFILL_WIKI_BLOB_BYTES ?? 8000);

/** Backfill wiki pages. Per-session blobs of ~8KB fed to runIngest. */
export async function runBackfillWiki(
  store: Store,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  if (status.wiki.running) {
    log('[backfill-wiki] already running; skip');
    return;
  }

  const files = listClaudeJsonl();
  const cursor = loadWikiCursor();

  const aborter = new AbortController();
  aborters.wiki = aborter;
  status.wiki = {
    ...emptyStatus('wiki'),
    running: true,
    started_at: new Date().toISOString(),
    files_total: files.length,
  };
  log(`[backfill-wiki] start: ${files.length} session files`);

  try {
    for (const file of files) {
      if (status.wiki.cancel_requested) {
        log('[backfill-wiki] cancel requested; stopping');
        break;
      }
      status.wiki.current_file = file;
      const prev = cursor.files[file];
      if (shouldSkipWiki(prev)) {
        status.wiki.files_skipped += 1;
        if (isWikiDone(prev)) {
          // already-done; quiet
        } else {
          // capped retries; surface in errors total but don't retry
        }
        continue;
      }
      try {
        const { cwd, turns } = readSessionTurns(file);
        if (turns.length === 0) {
          cursor.files[file] = 'done';
          saveWikiCursor(cursor);
          status.wiki.files_skipped += 1;
          continue;
        }

        const identity = resolveProjectIdentity(cwd ?? process.cwd());
        try {
          recordIdentity(identity);
        } catch {
          /* non-fatal */
        }

        // Pack turns into ~WIKI_BLOB_BYTES blobs to keep ingest passes
        // bounded. Each blob is one runIngest call.
        const blobs: string[] = [];
        let current: string[] = [];
        let currentBytes = 0;
        for (const t of turns) {
          const formatted = `${t.role}: ${t.text}`;
          const fb = Buffer.byteLength(formatted, 'utf-8');
          if (currentBytes + fb > WIKI_BLOB_BYTES && current.length > 0) {
            blobs.push(current.join('\n\n'));
            current = [];
            currentBytes = 0;
          }
          current.push(formatted);
          currentBytes += fb + 2;
        }
        if (current.length > 0) blobs.push(current.join('\n\n'));

        let ingested = 0;
        for (const blob of blobs) {
          if (status.wiki.cancel_requested) break;
          const result = await runIngest(
            store,
            {
              source: `backfill:${path.basename(file)}`,
              projectId: identity.id,
              projectName: identity.name,
              newContent: blob,
              evidenceHints: [],
              signal: aborter.signal,
            },
            log,
          );
          if (result.skipped_reason === 'aborted' || aborter.signal.aborted) {
            // User-driven cancel; treat as cancel, not error.
            break;
          }
          if (result.skipped_reason?.includes('LLM provider')) {
            // Provider down: don't mark file as done. Cancel the whole run
            // so the user fixes the provider before continuing.
            log(`[backfill-wiki] provider down: ${result.skipped_reason}`);
            status.wiki.cancel_requested = true;
            status.wiki.last_error = result.skipped_reason ?? 'provider down';
            status.wiki.errors += 1;
            break;
          }
          ingested += 1;
          status.wiki.chunks_or_pages +=
            result.pages_created.length + result.pages_updated.length;
          status.wiki.bytes_processed += Buffer.byteLength(blob, 'utf-8');
        }

        if (status.wiki.cancel_requested) break;

        cursor.files[file] = 'done';
        cursor.last_run_at = new Date().toISOString();
        saveWikiCursor(cursor);
        status.wiki.files_done += 1;
        savePersistedStatus();
        log(
          `[backfill-wiki] ${path.basename(file)} -> ${ingested} blobs, ${status.wiki.chunks_or_pages} pages so far`,
        );
      } catch (err) {
        const msg = (err as Error).message;
        const next = bumpFailure(prev, msg);
        cursor.files[file] = next;
        saveWikiCursor(cursor);
        status.wiki.errors += 1;
        status.wiki.last_error = msg;
        if (typeof next === 'object' && next.attempts < WIKI_MAX_ATTEMPTS) {
          log(
            `[backfill-wiki] ${file} attempt ${next.attempts}/${WIKI_MAX_ATTEMPTS} failed: ${msg} (will retry next start)`,
          );
        } else {
          log(
            `[backfill-wiki] ${file} permanently abandoned after ${WIKI_MAX_ATTEMPTS} attempts: ${msg}`,
          );
        }
      }
    }

    try {
      await store.flush();
    } catch (err) {
      log(`[backfill-wiki] final flush failed: ${(err as Error).message}`);
    }
    log(
      `[backfill-wiki] done: ${status.wiki.files_done}/${files.length} files, ${status.wiki.chunks_or_pages} pages, ${status.wiki.errors} errors`,
    );
  } finally {
    status.wiki.running = false;
    status.wiki.completed_at = new Date().toISOString();
    status.wiki.current_file = null;
    aborters.wiki = null;
    savePersistedStatus();
  }
}

/** Reset cursors so the next run reprocesses everything. Use with caution
 * - rare admin op (rebuild after a corruption recovery, etc). */
export function resetBackfill(mode: BackfillMode): void {
  if (mode === 'raw') {
    if (fs.existsSync(RAW_CURSOR_FILE)) fs.unlinkSync(RAW_CURSOR_FILE);
  } else {
    if (fs.existsSync(WIKI_CURSOR_FILE)) fs.unlinkSync(WIKI_CURSOR_FILE);
  }
}
