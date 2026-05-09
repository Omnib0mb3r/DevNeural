/**
 * Continuous auto-ingest from session activity.
 *
 * Reads each project's transcripts.jsonl since the last successful ingest
 * cursor, concatenates user-prompt + assistant turns into a fresh content
 * blob, and calls runIngest if the blob crosses a minimum-content threshold.
 * Each successful ingest advances the cursor so we never re-ingest the same
 * turns. Each ingest also schedules the always-on lint cycle (already wired
 * inside runIngest) so promote/archive runs minutes after the activity that
 * produced the content.
 *
 * Two trigger paths:
 *   1. SignalCoalescer fires from hook-runner SIGUSR1 every N events. This
 *      gives near-real-time response for actively-driven sessions.
 *   2. Periodic interval (default 5 min) catches sessions that don't
 *      produce hook signals (background work, ambient activity).
 *
 * Single-flight per-project: if an ingest is in flight for a project, new
 * triggers within that window are dropped (next signal/tick picks them up).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Store } from '../store/index.js';
import { listProjects } from '../identity/registry.js';
import { transcriptsFile, projectDir, ensureProjectDir } from '../paths.js';
import { runIngest } from './ingest.js';

interface CursorFile {
  /** Last byte offset into transcripts.jsonl that has been ingested. */
  byte_offset: number;
  /** Last successful ingest ISO timestamp; informational. */
  last_run_at: string | null;
}

const MIN_CONTENT_BYTES = Number(process.env.DEVNEURAL_AUTO_INGEST_MIN ?? 600);
const MAX_CONTENT_BYTES = Number(process.env.DEVNEURAL_AUTO_INGEST_MAX ?? 8_000);

const inflight = new Set<string>();

function cursorPath(projectId: string): string {
  return path.posix.join(projectDir(projectId), '.last-ingest');
}

function loadCursor(projectId: string): CursorFile {
  const p = cursorPath(projectId);
  if (!fs.existsSync(p)) {
    return { byte_offset: 0, last_run_at: null };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as CursorFile;
  } catch {
    return { byte_offset: 0, last_run_at: null };
  }
}

function saveCursor(projectId: string, cursor: CursorFile): void {
  ensureProjectDir(projectId);
  fs.writeFileSync(cursorPath(projectId), JSON.stringify(cursor, null, 2), 'utf-8');
}

interface TranscriptRecord {
  role?: string;
  kind?: string;
  text?: string;
  timestamp?: string;
}

function readNewTranscriptText(
  projectId: string,
  fromOffset: number,
): { content: string; newOffset: number } | null {
  const file = transcriptsFile(projectId);
  if (!fs.existsSync(file)) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.size <= fromOffset) return null;
  if (fromOffset > stat.size) {
    // File rotated/truncated; restart from beginning.
    return readNewTranscriptText(projectId, 0);
  }
  const length = stat.size - fromOffset;
  const fd = fs.openSync(file, 'r');
  let chunk: string;
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, fromOffset);
    chunk = buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }

  // The tail may end mid-line; only consume up to the last newline so we
  // don't try to JSON.parse a half-record.
  const lastNl = chunk.lastIndexOf('\n');
  if (lastNl < 0) return null;
  const consumable = chunk.slice(0, lastNl + 1);
  const consumedBytes = Buffer.byteLength(consumable, 'utf-8');

  const lines = consumable.split('\n').filter((l) => l.trim().length > 0);
  const turns: string[] = [];
  let totalBytes = 0;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as TranscriptRecord;
      // Only interested in human-driven content + Claude's natural text
      // responses. Skip tool outputs, sidebars, etc; they're already in
      // the raw vector store.
      const role = rec.role ?? '';
      const kind = rec.kind ?? '';
      if (role !== 'user' && role !== 'assistant') continue;
      if (kind !== 'text' && kind !== '') continue;
      const text = (rec.text ?? '').trim();
      if (!text) continue;
      const formatted = `${role}: ${text}`;
      totalBytes += Buffer.byteLength(formatted, 'utf-8') + 2;
      turns.push(formatted);
      if (totalBytes >= MAX_CONTENT_BYTES) break;
    } catch {
      continue;
    }
  }

  return {
    content: turns.join('\n\n'),
    newOffset: fromOffset + consumedBytes,
  };
}

export interface AutoIngestResult {
  projects_scanned: number;
  ingests_triggered: number;
  pages_created: number;
  pages_updated: number;
}

export async function runAutoIngest(
  store: Store,
  log: (msg: string) => void = () => undefined,
): Promise<AutoIngestResult> {
  const out: AutoIngestResult = {
    projects_scanned: 0,
    ingests_triggered: 0,
    pages_created: 0,
    pages_updated: 0,
  };

  const projects = listProjects();
  for (const project of projects) {
    out.projects_scanned++;
    if (inflight.has(project.id)) continue;

    const cursor = loadCursor(project.id);
    const read = readNewTranscriptText(project.id, cursor.byte_offset);
    if (!read) continue;
    if (Buffer.byteLength(read.content, 'utf-8') < MIN_CONTENT_BYTES) continue;

    inflight.add(project.id);
    try {
      log(
        `[auto-ingest] ${project.name}: ${Buffer.byteLength(read.content, 'utf-8')}B from offset ${cursor.byte_offset}`,
      );
      const result = await runIngest(
        store,
        {
          source: 'auto-ingest',
          projectId: project.id,
          projectName: project.name,
          newContent: read.content,
          evidenceHints: [],
        },
        log,
      );
      out.ingests_triggered++;
      out.pages_created += result.pages_created.length;
      out.pages_updated += result.pages_updated.length;

      // Advance cursor only on a real run (non-skipped). If the LLM
      // declined the content (skipped_reason set), leave the cursor so
      // the next tick can retry against fresh text.
      if (!result.skipped_reason) {
        saveCursor(project.id, {
          byte_offset: read.newOffset,
          last_run_at: new Date().toISOString(),
        });
      } else {
        log(`[auto-ingest] ${project.name}: skipped (${result.skipped_reason})`);
        // Even on skip, advance past content the LLM said was too short or
        // not interesting; otherwise we'd retry the same blob forever.
        if (
          result.skipped_reason === 'new content too short' ||
          result.skipped_reason?.includes('LLM provider')
        ) {
          // Provider issues should NOT advance — fix and retry.
          if (!result.skipped_reason.includes('LLM provider')) {
            saveCursor(project.id, {
              byte_offset: read.newOffset,
              last_run_at: cursor.last_run_at,
            });
          }
        }
      }
    } catch (err) {
      log(`[auto-ingest] ${project.name} failed: ${(err as Error).message}`);
    } finally {
      inflight.delete(project.id);
    }
  }

  return out;
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startAutoIngestInterval(
  store: Store,
  log: (msg: string) => void,
  ms = 5 * 60 * 1000,
): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    void runAutoIngest(store, log).catch((err) =>
      log(`[auto-ingest] interval failed: ${(err as Error).message}`),
    );
  }, ms);
  log(`[auto-ingest] interval started, every ${Math.round(ms / 1000)}s`);
}

export function stopAutoIngestInterval(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/* Force-flush a single project's pending transcript through ingest at
 * session-end, ignoring the MIN_CONTENT_BYTES floor that the periodic
 * loop respects. The wiki LLM still has its own internal "this isn't
 * worth a page" decision (skipped_reason), so a too-short blob just
 * comes back skipped without a malformed page being written. Returns
 * the same shape as runAutoIngest but scoped to one project. Used by
 * src/lex/session-end-pipeline.ts so a brainstorm/voice session that
 * ends mid-cycle still has its tail content delivered to the wiki
 * before the row goes to status='ended'. */
export async function forceIngestProject(
  store: Store,
  projectId: string,
  log: (msg: string) => void = () => undefined,
): Promise<AutoIngestResult> {
  const out: AutoIngestResult = {
    projects_scanned: 0,
    ingests_triggered: 0,
    pages_created: 0,
    pages_updated: 0,
  };
  const projects = listProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    log(`[auto-ingest:force] project ${projectId} not in registry; skip`);
    return out;
  }
  if (inflight.has(projectId)) {
    log(`[auto-ingest:force] ${projectId} already inflight; skip`);
    return out;
  }
  out.projects_scanned = 1;
  const cursor = loadCursor(projectId);
  const read = readNewTranscriptText(projectId, cursor.byte_offset);
  if (!read) {
    log(`[auto-ingest:force] ${project.name}: nothing past cursor`);
    return out;
  }
  inflight.add(projectId);
  try {
    log(
      `[auto-ingest:force] ${project.name}: ${Buffer.byteLength(read.content, 'utf-8')}B from offset ${cursor.byte_offset}`,
    );
    const result = await runIngest(
      store,
      {
        source: 'session-end',
        projectId: project.id,
        projectName: project.name,
        newContent: read.content,
        evidenceHints: [],
      },
      log,
    );
    out.ingests_triggered++;
    out.pages_created += result.pages_created.length;
    out.pages_updated += result.pages_updated.length;
    if (!result.skipped_reason) {
      saveCursor(projectId, {
        byte_offset: read.newOffset,
        last_run_at: new Date().toISOString(),
      });
    } else {
      log(`[auto-ingest:force] ${project.name}: skipped (${result.skipped_reason})`);
    }
  } catch (err) {
    log(`[auto-ingest:force] ${project.name} failed: ${(err as Error).message}`);
  } finally {
    inflight.delete(projectId);
  }
  return out;
}
