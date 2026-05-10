/**
 * Raw chunks cull rule (OP-4).
 *
 * Daily scheduled job that walks raw_chunks_meta for rows that
 * have aged past DEVNEURAL_RAW_CHUNK_CULL_AGE_DAYS (default 180)
 * AND are not brainstorm summaries AND have not been referenced
 * by the curator. Archives matched rows to a sibling
 * raw_chunks_archived table and drops them from the vector index.
 *
 * brainstorm_chunks (the BF-3 full-transcript shape) is a
 * different table and is NEVER touched by this job. BF-2 keeps
 * brainstorm chunks no-decay forever; the cull is for ordinary
 * project transcripts only.
 *
 * "curator reference" check: until raw chunks have a stable
 * back-pointer in curator_log (today curator_log only tracks the
 * wiki-page slug it injected, not raw chunk fallbacks), we read
 * the rolling reinforcement.log.jsonl for any line tagged
 * source='raw' against this chunk_id. A row with at least one hit
 * stays. Future Phase Two work (Wave 3 curator extension) can add
 * a raw_chunk_id column to curator_log and switch this scan to a
 * SQL JOIN; the cull contract stays the same.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Store } from '../store/index.js';

const DEFAULT_AGE_DAYS = 180;

export interface CullOptions {
  ageDays?: number;
  log?: (msg: string) => void;
  /* Test override for the reinforcement-log path. Defaults to
   * <DATA_ROOT>/reinforcement.log.jsonl. */
  reinforcementLogPath?: string;
}

export interface CullResult {
  scanned: number;
  archived: number;
  skipped_recent: number;
  skipped_brainstorm_summary: number;
  skipped_referenced: number;
}

function ensureArchiveTable(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_chunks_archived (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      role         TEXT NOT NULL,
      byte_length  INTEGER NOT NULL,
      archived_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS raw_chunks_archived_session
      ON raw_chunks_archived(session_id);
  `);
}

function loadReferencedChunkIds(logPath: string): Set<string> {
  const refs = new Set<string>();
  if (!fs.existsSync(logPath)) return refs;
  const raw = fs.readFileSync(logPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        kind?: string;
        source?: string;
        chunk?: string;
      };
      /* Any reinforcement-log line that references a chunk by id
       * counts as a reference. We do not differentiate inject vs
       * hit vs correction because any signal at all means the
       * chunk earned its keep. */
      if (typeof obj.chunk === 'string') refs.add(obj.chunk);
    } catch {
      continue;
    }
  }
  return refs;
}

export async function cullRawChunks(
  store: Store,
  opts: CullOptions = {},
): Promise<CullResult> {
  const ageDays =
    opts.ageDays ?? Number(process.env.DEVNEURAL_RAW_CHUNK_CULL_AGE_DAYS ?? DEFAULT_AGE_DAYS);
  const log = opts.log ?? (() => undefined);

  const dataRoot =
    process.env.DEVNEURAL_DATA_ROOT?.replace(/\\/g, '/') ??
    'C:/dev/data/skill-connections';
  const reinforcementLogPath =
    opts.reinforcementLogPath ?? path.posix.join(dataRoot, 'reinforcement.log.jsonl');

  const result: CullResult = {
    scanned: 0,
    archived: 0,
    skipped_recent: 0,
    skipped_brainstorm_summary: 0,
    skipped_referenced: 0,
  };

  /* Reach into the IndexDb's better-sqlite3 instance through the
   * narrow public surface we already use elsewhere (insertOutboundLog
   * etc do the same). The structural cast keeps the API tight. */
  const dbHandle = (store.db as unknown as { db: import('better-sqlite3').Database }).db;
  ensureArchiveTable(dbHandle);

  const cutoffMs = Date.now() - ageDays * 24 * 60 * 60 * 1000;
  const referenced = loadReferencedChunkIds(reinforcementLogPath);

  const candidates = dbHandle
    .prepare(
      `SELECT id, project_id, session_id, timestamp_ms, kind, role, byte_length
       FROM raw_chunks_meta
       WHERE timestamp_ms < ?`,
    )
    .all(cutoffMs) as Array<{
    id: string;
    project_id: string;
    session_id: string;
    timestamp_ms: number;
    kind: string;
    role: string;
    byte_length: number;
  }>;
  result.scanned = candidates.length;

  const insertArchive = dbHandle.prepare(
    `INSERT OR IGNORE INTO raw_chunks_archived
       (id, project_id, session_id, timestamp_ms, kind, role, byte_length)
     VALUES (@id, @project_id, @session_id, @timestamp_ms, @kind, @role, @byte_length)`,
  );
  const deleteMeta = dbHandle.prepare(`DELETE FROM raw_chunks_meta WHERE id = ?`);

  /* Vector store delete is best-effort: not every store
   * implementation exposes a delete-by-id; on missing API we just
   * leave the vector orphaned and the metadata row gone (the
   * vector becomes unreachable for future scoring because
   * raw_chunks_meta is the only join key). */
  const vectorStore = store.rawChunks as unknown as {
    delete?: (id: string) => Promise<void> | void;
  };

  const txn = dbHandle.transaction((rows: typeof candidates) => {
    for (const row of rows) {
      if (row.kind === 'brainstorm-summary') {
        result.skipped_brainstorm_summary += 1;
        continue;
      }
      if (referenced.has(row.id)) {
        result.skipped_referenced += 1;
        continue;
      }
      insertArchive.run(row);
      deleteMeta.run(row.id);
      result.archived += 1;
    }
  });
  txn(candidates);

  /* Vector deletes happen outside the SQL transaction so a partial
   * vector-store failure does not roll back the metadata move. The
   * metadata is the source of truth for future scoring. */
  if (typeof vectorStore.delete === 'function') {
    for (const row of candidates) {
      if (row.kind === 'brainstorm-summary' || referenced.has(row.id)) continue;
      try {
        await vectorStore.delete(row.id);
      } catch (err) {
        log(`[cull] vector delete ${row.id} failed: ${(err as Error).message}`);
      }
    }
  }

  result.skipped_recent = 0; // candidates query already filters by age
  log(
    `[cull] scanned=${result.scanned} archived=${result.archived} ` +
      `skipped_brainstorm_summary=${result.skipped_brainstorm_summary} ` +
      `skipped_referenced=${result.skipped_referenced}`,
  );
  return result;
}
