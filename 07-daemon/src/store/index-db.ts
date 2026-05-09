/**
 * SQLite metadata + FTS5 index.
 *
 * Two purposes:
 *   1. Fast metadata filter / sort that the vector store does not do
 *      well at scale: by project, by recency, by status, by weight.
 *   2. FTS5 inverted index over wiki page bodies and trigger/insight
 *      fields, used for keyword-precise candidate selection at ingest.
 *
 * Synchronous via better-sqlite3. Daemon owns a single instance.
 */
import Database from 'better-sqlite3';
import * as path from 'node:path';
import { DATA_ROOT, ensureDataRoot } from '../paths.js';

export interface RawChunkRow {
  id: string;
  project_id: string;
  session_id: string;
  timestamp_ms: number;
  kind: string;
  role: string;
  byte_length: number;
}

export interface WikiPageRow {
  id: string;
  title: string;
  trigger: string;
  insight: string;
  status: 'pending' | 'canonical' | 'archived';
  weight: number;
  hits: number;
  corrections: number;
  created_ms: number;
  last_touched_ms: number;
  projects_json: string;
  human_edited: number;
}

export interface BrainstormSessionRow {
  id: string;
  claude_session_id: string | null;
  pty_id: string | null;
  cwd: string;
  user_label: string | null;
  derived_label: string | null;
  mode: string;
  status: string;
  started_ms: number;
  ended_ms: number | null;
  turn_count: number;
  topic_tags_json: string;
  artifacts_json: string;
  last_summary: string | null;
  last_summary_ms: number | null;
}

export interface FtsHit {
  page_id: string;
  rank: number;
  title: string;
  trigger: string;
  insight: string;
}

export class IndexDb {
  private db: Database.Database;

  constructor(filePath?: string) {
    ensureDataRoot();
    const file =
      filePath ?? path.posix.join(DATA_ROOT, 'index.db');
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS raw_chunks_meta (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        byte_length INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_raw_project_recency
        ON raw_chunks_meta (project_id, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_raw_session
        ON raw_chunks_meta (session_id);

      CREATE TABLE IF NOT EXISTS wiki_pages_meta (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        trigger TEXT NOT NULL,
        insight TEXT NOT NULL,
        status TEXT NOT NULL,
        weight REAL NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        corrections INTEGER NOT NULL DEFAULT 0,
        created_ms INTEGER NOT NULL,
        last_touched_ms INTEGER NOT NULL,
        projects_json TEXT NOT NULL DEFAULT '[]',
        human_edited INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_status_weight
        ON wiki_pages_meta (status, weight DESC);
      CREATE INDEX IF NOT EXISTS idx_wiki_recency
        ON wiki_pages_meta (last_touched_ms DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
        page_id UNINDEXED,
        title,
        trigger,
        insight,
        body,
        tokenize='porter'
      );

      CREATE TABLE IF NOT EXISTS cross_refs (
        from_page TEXT NOT NULL,
        to_page TEXT NOT NULL,
        PRIMARY KEY (from_page, to_page)
      );
      CREATE INDEX IF NOT EXISTS idx_cross_refs_to ON cross_refs (to_page);

      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '1');

      /* Brainstorm sessions are first-class records, not just claude
       * jsonl traces. Each Lex spawn creates one; lifecycle moves
       * through 'active' -> 'ended'. The user_label is what the user
       * named it ("pricing rethink"); the derived_label is Lex's
       * later guess if user skipped initially. artifacts_json holds
       * inline references to research notes / wiki drafts / spawned
       * projects / reminders captured during this session, so the
       * brainstorm has a durable knowledge graph instead of just
       * transcript chunks. */
      CREATE TABLE IF NOT EXISTS brainstorm_sessions (
        id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        pty_id TEXT,
        cwd TEXT NOT NULL,
        user_label TEXT,
        derived_label TEXT,
        mode TEXT NOT NULL DEFAULT 'conversation',
        status TEXT NOT NULL DEFAULT 'active',
        started_ms INTEGER NOT NULL,
        ended_ms INTEGER,
        turn_count INTEGER NOT NULL DEFAULT 0,
        topic_tags_json TEXT NOT NULL DEFAULT '[]',
        artifacts_json TEXT NOT NULL DEFAULT '{}',
        last_summary TEXT,
        last_summary_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_brainstorm_status
        ON brainstorm_sessions (status, started_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_brainstorm_claude
        ON brainstorm_sessions (claude_session_id);
      CREATE INDEX IF NOT EXISTS idx_brainstorm_pty
        ON brainstorm_sessions (pty_id);
    `);
  }

  // ── brainstorm sessions ────────────────────────────────────────
  insertBrainstorm(row: BrainstormSessionRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO brainstorm_sessions
         (id, claude_session_id, pty_id, cwd, user_label, derived_label, mode,
          status, started_ms, ended_ms, turn_count, topic_tags_json, artifacts_json,
          last_summary, last_summary_ms)
         VALUES (@id, @claude_session_id, @pty_id, @cwd, @user_label, @derived_label,
          @mode, @status, @started_ms, @ended_ms, @turn_count, @topic_tags_json,
          @artifacts_json, @last_summary, @last_summary_ms)`,
      )
      .run(row);
  }

  updateBrainstorm(
    id: string,
    patch: Partial<BrainstormSessionRow>,
  ): BrainstormSessionRow | null {
    const existing = this.getBrainstorm(id);
    if (!existing) return null;
    const merged: BrainstormSessionRow = { ...existing, ...patch, id };
    this.insertBrainstorm(merged);
    return merged;
  }

  getBrainstorm(id: string): BrainstormSessionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM brainstorm_sessions WHERE id = ?`)
        .get(id) as BrainstormSessionRow | undefined) ?? null
    );
  }

  getBrainstormByClaudeSession(
    claudeSessionId: string,
  ): BrainstormSessionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM brainstorm_sessions WHERE claude_session_id = ? LIMIT 1`,
        )
        .get(claudeSessionId) as BrainstormSessionRow | undefined) ?? null
    );
  }

  getBrainstormByPty(ptyId: string): BrainstormSessionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM brainstorm_sessions WHERE pty_id = ? ORDER BY started_ms DESC LIMIT 1`,
        )
        .get(ptyId) as BrainstormSessionRow | undefined) ?? null
    );
  }

  listBrainstorms(opts: { status?: 'active' | 'ended'; limit?: number } = {}):
    BrainstormSessionRow[] {
    const limit = opts.limit ?? 50;
    if (opts.status) {
      return this.db
        .prepare(
          `SELECT * FROM brainstorm_sessions WHERE status = ? ORDER BY started_ms DESC LIMIT ?`,
        )
        .all(opts.status, limit) as BrainstormSessionRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM brainstorm_sessions ORDER BY started_ms DESC LIMIT ?`,
      )
      .all(limit) as BrainstormSessionRow[];
  }

  upsertRawChunk(row: RawChunkRow): void {
    const stmt = this.db.prepare(
      `INSERT INTO raw_chunks_meta (id, project_id, session_id, timestamp_ms, kind, role, byte_length)
       VALUES (@id, @project_id, @session_id, @timestamp_ms, @kind, @role, @byte_length)
       ON CONFLICT(id) DO UPDATE SET
         project_id=excluded.project_id,
         session_id=excluded.session_id,
         timestamp_ms=excluded.timestamp_ms,
         kind=excluded.kind,
         role=excluded.role,
         byte_length=excluded.byte_length`,
    );
    stmt.run(row);
  }

  upsertWikiPage(row: WikiPageRow, body: string): void {
    const insert = this.db.prepare(
      `INSERT INTO wiki_pages_meta (id, title, trigger, insight, status, weight, hits, corrections, created_ms, last_touched_ms, projects_json, human_edited)
       VALUES (@id, @title, @trigger, @insight, @status, @weight, @hits, @corrections, @created_ms, @last_touched_ms, @projects_json, @human_edited)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title,
         trigger=excluded.trigger,
         insight=excluded.insight,
         status=excluded.status,
         weight=excluded.weight,
         hits=excluded.hits,
         corrections=excluded.corrections,
         last_touched_ms=excluded.last_touched_ms,
         projects_json=excluded.projects_json,
         human_edited=excluded.human_edited`,
    );
    const txn = this.db.transaction(() => {
      insert.run(row);
      this.db
        .prepare(`DELETE FROM wiki_fts WHERE page_id = ?`)
        .run(row.id);
      this.db
        .prepare(
          `INSERT INTO wiki_fts (page_id, title, trigger, insight, body) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(row.id, row.title, row.trigger, row.insight, body);
    });
    txn();
  }

  recentRawChunks(
    projectId: string,
    limit: number,
  ): RawChunkRow[] {
    return this.db
      .prepare(
        `SELECT id, project_id, session_id, timestamp_ms, kind, role, byte_length
         FROM raw_chunks_meta
         WHERE project_id = ?
         ORDER BY timestamp_ms DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as RawChunkRow[];
  }

  ftsSearchWiki(query: string, limit = 20): FtsHit[] {
    const rows = this.db
      .prepare(
        `SELECT page_id, rank, title, trigger, insight
         FROM wiki_fts
         WHERE wiki_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as FtsHit[];
    return rows;
  }

  topPagesByWeight(
    status: 'pending' | 'canonical' | 'archived',
    limit = 50,
  ): WikiPageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM wiki_pages_meta WHERE status = ? ORDER BY weight DESC LIMIT ?`,
      )
      .all(status, limit) as WikiPageRow[];
  }

  pageById(id: string): WikiPageRow | undefined {
    return this.db
      .prepare(`SELECT * FROM wiki_pages_meta WHERE id = ?`)
      .get(id) as WikiPageRow | undefined;
  }

  setCrossRefs(fromPage: string, toPages: string[]): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM cross_refs WHERE from_page = ?`)
        .run(fromPage);
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO cross_refs (from_page, to_page) VALUES (?, ?)`,
      );
      for (const to of toPages) insert.run(fromPage, to);
    });
    txn();
  }

  neighbors(pageId: string, hops = 1): Set<string> {
    const visited = new Set<string>([pageId]);
    let frontier: string[] = [pageId];
    for (let h = 0; h < hops; h++) {
      const next = new Set<string>();
      for (const id of frontier) {
        const out = this.db
          .prepare(`SELECT to_page FROM cross_refs WHERE from_page = ?`)
          .all(id) as { to_page: string }[];
        const incoming = this.db
          .prepare(`SELECT from_page FROM cross_refs WHERE to_page = ?`)
          .all(id) as { from_page: string }[];
        for (const r of out) {
          if (!visited.has(r.to_page)) {
            visited.add(r.to_page);
            next.add(r.to_page);
          }
        }
        for (const r of incoming) {
          if (!visited.has(r.from_page)) {
            visited.add(r.from_page);
            next.add(r.from_page);
          }
        }
      }
      frontier = Array.from(next);
      if (frontier.length === 0) break;
    }
    visited.delete(pageId);
    return visited;
  }

  close(): void {
    this.db.close();
  }
}
