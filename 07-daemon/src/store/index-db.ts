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
  /* Phase Two columns (added by migrations 004). Optional in the TS
   * type so legacy code paths and tests that build rows without
   * Phase Two awareness continue to compile. SQLite supplies defaults
   * (kind='brainstorm', consent_acked=0, keep_audio=0,
   * provenance='voice') so reads always populate these. */
  project_slug?: string | null;
  audio_path?: string | null;
  distilled_at?: string | null;
  kind?: 'brainstorm' | 'meeting';
  attendees?: string | null;
  meeting_topic?: string | null;
  consent_acked?: number;
  consent_acked_at?: string | null;
  consent_acked_by?: string | null;
  keep_audio?: number;
  provenance?: 'voice' | 'audit-document' | 'synthetic';
}

/* brainstorm_chunks row. Backing table for full-transcript retrieval
 * of voice sessions. Populated by the session-end pipeline + by
 * Wave 2 day 3 backfill / audit-doc auto-ingest. */
export interface BrainstormChunkRow {
  id: string;
  brainstorm_id: string;
  turn_index: number;
  role: 'user' | 'lex' | 'tool';
  mode: 'conversation' | 'notes' | 'push-to-talk';
  text: string;
  model_id: string;
  no_decay: number;
  created_at: string;
}

/* backfill_review_queue row. Populated by npm run backfill-brainstorms
 * with one (page, brainstorm) candidate pair per band; the dashboard
 * empties the queue at /brainstorms/backfill-review. */
export interface BackfillReviewRow {
  id: string;
  brainstorm_id: string;
  candidate_page_slug: string;
  cosine: number;
  band: 'high' | 'borderline' | 'low';
  status: 'pending' | 'linked' | 'rejected' | 'skipped';
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

/* wiki_drafts row. Created by the session-end distillation pipeline
 * (BF-7). Reviewed via /drafts (Wave 2 day 2). */
export interface WikiDraftRow {
  id: string;
  brainstorm_id: string;
  page_slug: string;
  page_title: string;
  body_markdown: string;
  confidence: number;
  status:
    | 'pending'
    | 'promoted'
    | 'discarded'
    | 'auto-promoted'
    | 'auto-dropped'
    | 'superseded';
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
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

  // ── curator log (CI-1 / CI-2) ──────────────────────────────────
  /* Records every curator decision (inject or silence) at
   * UserPromptSubmit. Drives Curator Health card and the canary.
   * The DB schema enforces UNIQUE prompt_id; callers must generate
   * a fresh UUID per call. */
  insertCuratorLog(row: {
    id: string;
    prompt_id: string;
    session_id: string;
    project_slug: string;
    decision: 'inject' | 'silence';
    page_slug: string | null;
    score: number | null;
    threshold: number;
    confidence: number | null;
    source_class: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO curator_log
           (id, prompt_id, session_id, project_slug, decision, page_slug,
            score, threshold, confidence, source_class)
         VALUES (@id, @prompt_id, @session_id, @project_slug, @decision,
            @page_slug, @score, @threshold, @confidence, @source_class)`,
      )
      .run(row);
  }

  /* CI-2: hits, corrections, clicks. Multiple rows per curator_log
   * row are allowed; each follow-up signal appends. */
  insertCuratorSignal(row: {
    id: string;
    curator_log_id: string;
    prompt_id: string;
    signal: 'hit' | 'correction' | 'click' | 'wrong';
    source: 'regex-inferred' | 'user-explicit' | 'dashboard-click';
    weight: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO curator_signal
           (id, curator_log_id, prompt_id, signal, source, weight)
         VALUES (@id, @curator_log_id, @prompt_id, @signal, @source, @weight)`,
      )
      .run(row);
  }

  /* CI-6: Curator Health KPI card aggregates over a rolling window.
   * Returns counts for the spec's required dimensions; the route
   * layer turns these into rates. Window is days, default 7. */
  curatorHealthWindow(windowDays = 7): {
    injections_per_day: Array<{ day: string; count: number }>;
    inject_total: number;
    silence_total: number;
    hit_total: number;
    correction_total: number;
    click_total: number;
    wrong_total: number;
  } {
    const since = `now('-${windowDays} days')`;
    const perDay = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
         FROM curator_log
         WHERE decision = 'inject'
           AND created_at >= datetime('now', ?)
         GROUP BY day
         ORDER BY day`,
      )
      .all(`-${windowDays} days`) as Array<{ day: string; count: number }>;
    const counts = this.db
      .prepare(
        `SELECT decision, COUNT(*) AS n
         FROM curator_log
         WHERE created_at >= datetime('now', ?)
         GROUP BY decision`,
      )
      .all(`-${windowDays} days`) as Array<{ decision: string; n: number }>;
    const sigCounts = this.db
      .prepare(
        `SELECT signal, COUNT(*) AS n
         FROM curator_signal
         WHERE created_at >= datetime('now', ?)
         GROUP BY signal`,
      )
      .all(`-${windowDays} days`) as Array<{ signal: string; n: number }>;
    void since;
    const inject = counts.find((c) => c.decision === 'inject')?.n ?? 0;
    const silence = counts.find((c) => c.decision === 'silence')?.n ?? 0;
    return {
      injections_per_day: perDay,
      inject_total: inject,
      silence_total: silence,
      hit_total: sigCounts.find((s) => s.signal === 'hit')?.n ?? 0,
      correction_total:
        sigCounts.find((s) => s.signal === 'correction')?.n ?? 0,
      click_total: sigCounts.find((s) => s.signal === 'click')?.n ?? 0,
      wrong_total: sigCounts.find((s) => s.signal === 'wrong')?.n ?? 0,
    };
  }

  // ── heartbeat_log (OP-1) ──────────────────────────────────────
  insertHeartbeatRow(row: {
    id: string;
    daemon_pid: number;
    daemon_version: string;
    status: 'posted' | 'ack' | 'no-ack' | 'watcher-alarm';
    detail?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO heartbeat_log (id, daemon_pid, daemon_version, status, detail)
         VALUES (@id, @daemon_pid, @daemon_version, @status, @detail)`,
      )
      .run({ detail: null, ...row });
  }

  updateHeartbeatStatus(
    id: string,
    status: 'ack' | 'no-ack' | 'watcher-alarm',
    detail?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE heartbeat_log SET status = ?, detail = COALESCE(?, detail) WHERE id = ?`,
      )
      .run(status, detail ?? null, id);
  }

  // ── wiki_drafts (BF-7) ─────────────────────────────────────────
  /* Insert a pending wiki draft produced by the session-end auto-
   * distillation. brainstorm_id is the voice-session FK (column name
   * retained for compatibility per CODEX-002 B4). status defaults to
   * 'pending'; the user reviews via /drafts and promotes / edits /
   * discards. */
  insertWikiDraft(row: {
    id: string;
    brainstorm_id: string;
    page_slug: string;
    page_title: string;
    body_markdown: string;
    confidence: number;
    status?: 'pending' | 'promoted' | 'discarded' | 'auto-promoted' | 'auto-dropped' | 'superseded';
  }): void {
    this.db
      .prepare(
        `INSERT INTO wiki_drafts
           (id, brainstorm_id, page_slug, page_title, body_markdown, confidence, status)
         VALUES (@id, @brainstorm_id, @page_slug, @page_title, @body_markdown, @confidence, @status)`,
      )
      .run({ status: 'pending', ...row });
  }

  /* Set the distillation timestamp on the brainstorm_sessions row.
   * Called at the end of a successful session-end pipeline (BF-7
   * step 7) so /brainstorms route can show the distilled state. */
  setBrainstormDistilledAt(brainstormId: string, isoTs: string): void {
    this.db
      .prepare(
        `UPDATE brainstorm_sessions SET distilled_at = ? WHERE id = ?`,
      )
      .run(isoTs, brainstormId);
  }

  /* Wave 2 day 2 step 11 (BF-11/A4): record the data-root-relative
   * path to the finalised audio bundle for this brainstorm. Set by
   * the audio finaliser during the session-end pipeline. Stays NULL
   * for sessions without audio (meeting with consent_acked=0 or text-
   * only brainstorms). */
  setBrainstormAudioPath(brainstormId: string, audioPath: string | null): void {
    this.db
      .prepare(
        `UPDATE brainstorm_sessions SET audio_path = ? WHERE id = ?`,
      )
      .run(audioPath, brainstormId);
  }

  /* Wave 2 day 3: dedicated setters for the Phase Two additive columns.
   * insertBrainstorm() / updateBrainstorm() round-trip via INSERT OR
   * REPLACE on the legacy 15-column shape, which silently resets the
   * Phase Two columns to their SQLite defaults. Backfill + audit-doc
   * ingest must use these direct UPDATEs to persist kind, provenance,
   * project_slug, consent flags, distillation timestamps, and the
   * meeting topic / attendees fields. */
  setBrainstormPhaseTwo(
    brainstormId: string,
    patch: Partial<{
      kind: 'brainstorm' | 'meeting';
      provenance: 'voice' | 'audit-document' | 'synthetic';
      project_slug: string | null;
      audio_path: string | null;
      consent_acked: number;
      consent_acked_at: string | null;
      consent_acked_by: string | null;
      keep_audio: number;
      attendees: string | null;
      meeting_topic: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(v as string | number | null);
    }
    if (sets.length === 0) return;
    params.push(brainstormId);
    this.db
      .prepare(
        `UPDATE brainstorm_sessions SET ${sets.join(', ')} WHERE id = ?`,
      )
      .run(...params);
  }

  /* Wave 2 day 3: brainstorm_chunks helpers. Insert is best-effort
   * idempotent via INSERT OR REPLACE on the primary key so backfill
   * retries do not duplicate rows. listBrainstormChunks walks the
   * full session in turn order so callers can recover the transcript
   * deterministically (no JS sort needed). */
  insertBrainstormChunk(row: {
    id: string;
    brainstorm_id: string;
    turn_index: number;
    role: 'user' | 'lex' | 'tool';
    mode: 'conversation' | 'notes' | 'push-to-talk';
    text: string;
    model_id: string;
    no_decay?: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO brainstorm_chunks
           (id, brainstorm_id, turn_index, role, mode, text, model_id, no_decay)
         VALUES (@id, @brainstorm_id, @turn_index, @role, @mode, @text, @model_id, @no_decay)`,
      )
      .run({ no_decay: 1, ...row });
  }

  countBrainstormChunks(brainstormId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM brainstorm_chunks WHERE brainstorm_id = ?`)
      .get(brainstormId) as { n: number };
    return r.n;
  }

  listBrainstormChunks(brainstormId: string, limit = 1000): BrainstormChunkRow[] {
    return this.db
      .prepare(
        `SELECT * FROM brainstorm_chunks WHERE brainstorm_id = ? ORDER BY turn_index ASC LIMIT ?`,
      )
      .all(brainstormId, limit) as BrainstormChunkRow[];
  }

  /* Wave 2 day 3 backfill_review_queue helpers. Insert is the band
   * classifier's write path; the list helper drives /brainstorms/
   * backfill-review; the update helper handles one-click link / reject
   * from the dashboard. */
  insertBackfillReview(row: {
    id: string;
    brainstorm_id: string;
    candidate_page_slug: string;
    cosine: number;
    band: 'high' | 'borderline' | 'low';
    status?: 'pending' | 'linked' | 'rejected' | 'skipped';
  }): void {
    this.db
      .prepare(
        `INSERT INTO backfill_review_queue
           (id, brainstorm_id, candidate_page_slug, cosine, band, status)
         VALUES (@id, @brainstorm_id, @candidate_page_slug, @cosine, @band, @status)`,
      )
      .run({ status: 'pending', ...row });
  }

  listBackfillReview(opts: {
    status?: 'pending' | 'linked' | 'rejected' | 'skipped';
    band?: 'high' | 'borderline' | 'low';
    limit?: number;
  } = {}): BackfillReviewRow[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.status) {
      where.push(`status = ?`);
      params.push(opts.status);
    }
    if (opts.band) {
      where.push(`band = ?`);
      params.push(opts.band);
    }
    const sql =
      `SELECT * FROM backfill_review_queue` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY cosine DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as BackfillReviewRow[];
  }

  updateBackfillReview(
    id: string,
    patch: { status: 'linked' | 'rejected' | 'skipped'; resolved_by?: string },
  ): BackfillReviewRow | null {
    this.db
      .prepare(
        `UPDATE backfill_review_queue
         SET status = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolved_by = ?
         WHERE id = ?`,
      )
      .run(patch.status, patch.resolved_by ?? 'user', id);
    return (
      (this.db
        .prepare(`SELECT * FROM backfill_review_queue WHERE id = ?`)
        .get(id) as BackfillReviewRow | undefined) ?? null
    );
  }

  /* CP-1 fallback audit log. Wave 2 day 3 reuses this table for the
   * low-band backfill candidates so the user can audit ignored pairs
   * without a separate table. */
  insertCrossprojectFallback(row: {
    id: string;
    candidate_slug: string;
    reason: string;
    participating_projects: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO crossproject_fallback_log
           (id, candidate_slug, reason, participating_projects)
         VALUES (@id, @candidate_slug, @reason, @participating_projects)`,
      )
      .run(row);
  }

  /* Wave 2 day 2 step 9 list filter helper. Combines the kind /
   * project_slug / mode / day filters into a single prepared query
   * so the /brainstorms route does not need to do post-fetch JS
   * filtering on large session histories. Date is YYYY-MM-DD against
   * started_ms in UTC. */
  listBrainstormsFiltered(opts: {
    kind?: 'brainstorm' | 'meeting';
    project_slug?: string;
    mode?: string;
    date?: string;
    limit?: number;
  } = {}): BrainstormSessionRow[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.kind) {
      where.push(`COALESCE(kind, 'brainstorm') = ?`);
      params.push(opts.kind);
    }
    if (opts.project_slug) {
      where.push(`project_slug = ?`);
      params.push(opts.project_slug);
    }
    if (opts.mode) {
      where.push(`mode = ?`);
      params.push(opts.mode);
    }
    if (opts.date) {
      where.push(
        `substr(strftime('%Y-%m-%dT%H:%M:%SZ', started_ms / 1000.0, 'unixepoch'), 1, 10) = ?`,
      );
      params.push(opts.date);
    }
    const sql =
      `SELECT * FROM brainstorm_sessions` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY started_ms DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as BrainstormSessionRow[];
  }

  /* wiki_drafts list + detail + mutation helpers. Wave 1 ships only
   * insert via the distillation pipeline; Wave 2 day 2 adds the
   * review surface (/drafts) so the user can promote / edit / discard
   * drafts. status filter accepts a single status; pass undefined to
   * see everything. */
  listWikiDrafts(opts: {
    status?: 'pending' | 'promoted' | 'discarded' | 'auto-promoted' | 'auto-dropped' | 'superseded';
    limit?: number;
  } = {}): WikiDraftRow[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    if (opts.status) {
      return this.db
        .prepare(
          `SELECT * FROM wiki_drafts WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(opts.status, limit) as WikiDraftRow[];
    }
    return this.db
      .prepare(`SELECT * FROM wiki_drafts ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as WikiDraftRow[];
  }

  getWikiDraft(id: string): WikiDraftRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM wiki_drafts WHERE id = ?`)
        .get(id) as WikiDraftRow | undefined) ?? null
    );
  }

  /* Slug lookup used by the /drafts/:id/promote conflict detector.
   * Returns the most recent draft for the given slug across the
   * supplied statuses, so callers can spot the "another draft for the
   * same slug already shipped" case (superseded race) without doing
   * the join themselves. */
  wikiDraftsBySlug(
    slug: string,
    statuses: Array<'pending' | 'promoted' | 'discarded' | 'auto-promoted' | 'auto-dropped' | 'superseded'>,
  ): WikiDraftRow[] {
    if (statuses.length === 0) return [];
    const qs = statuses.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT * FROM wiki_drafts WHERE page_slug = ? AND status IN (${qs}) ORDER BY created_at DESC`,
      )
      .all(slug, ...statuses) as WikiDraftRow[];
  }

  /* Apply an inline edit and / or terminal status update to a draft.
   * Body fields are merged; status transitions stamp resolved_at +
   * resolved_by. Returns the merged row or null if the id is unknown. */
  updateWikiDraft(
    id: string,
    patch: {
      page_slug?: string;
      page_title?: string;
      body_markdown?: string;
      status?: 'pending' | 'promoted' | 'discarded' | 'auto-promoted' | 'auto-dropped' | 'superseded';
      resolved_by?: string;
    },
  ): WikiDraftRow | null {
    const existing = this.getWikiDraft(id);
    if (!existing) return null;
    const isTerminal =
      patch.status &&
      patch.status !== 'pending' &&
      existing.status !== patch.status;
    const merged: WikiDraftRow = {
      ...existing,
      ...patch,
      resolved_at: isTerminal
        ? new Date().toISOString()
        : existing.resolved_at,
      resolved_by: isTerminal
        ? patch.resolved_by ?? existing.resolved_by ?? 'user'
        : existing.resolved_by,
    };
    this.db
      .prepare(
        `UPDATE wiki_drafts
         SET page_slug = @page_slug,
             page_title = @page_title,
             body_markdown = @body_markdown,
             confidence = @confidence,
             status = @status,
             resolved_at = @resolved_at,
             resolved_by = @resolved_by
         WHERE id = @id`,
      )
      .run(merged);
    return merged;
  }

  /* Read the kind column (and other Phase Two state) for a single
   * brainstorm. Convenience wrapper around getBrainstorm() that
   * tolerates the legacy null-kind shape. */
  brainstormKind(brainstormId: string): 'brainstorm' | 'meeting' {
    const row = this.getBrainstorm(brainstormId);
    return row?.kind === 'meeting' ? 'meeting' : 'brainstorm';
  }

  // ── outbound log (PB-2 / BF-4) ────────────────────────────────
  /* Records every outbound call. The DB trigger
   * outbound_no_voice_session blocks any insert whose payload_class
   * starts with 'brainstorm-' or 'meeting-' OR whose
   * contains_voice_session_source flag is 1, so callers MUST set
   * contains_voice_session_source accurately. Returning the inserted
   * id lets callers update response_status + error after the call. */
  insertOutboundLog(row: {
    id: string;
    destination: string;
    purpose: string;
    payload_class: string;
    contains_voice_session_source: 0 | 1;
    payload_bytes: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO outbound_log
           (id, destination, purpose, payload_class, contains_voice_session_source, payload_bytes)
         VALUES (@id, @destination, @purpose, @payload_class, @contains_voice_session_source, @payload_bytes)`,
      )
      .run(row);
  }

  finalizeOutboundLog(
    id: string,
    patch: {
      response_status?: number;
      error?: string;
      failure_code?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE outbound_log
         SET response_status = COALESCE(@response_status, response_status),
             response_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             error = COALESCE(@error, error),
             failure_code = COALESCE(@failure_code, failure_code)
         WHERE id = @id`,
      )
      .run({
        id,
        response_status: patch.response_status ?? null,
        error: patch.error ?? null,
        failure_code: patch.failure_code ?? null,
      });
  }

  /* Returns today's UTC totals from outbound_log. Used by the daily
   * cap check before any new outbound call. */
  outboundTodayUsage(): { calls: number; bytes: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(payload_bytes), 0) AS bytes
         FROM outbound_log
         WHERE substr(request_at, 1, 10) = strftime('%Y-%m-%d', 'now')`,
      )
      .get() as { calls: number; bytes: number };
    return { calls: row.calls, bytes: row.bytes };
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

  /* Project id for a given session, derived from the most recent raw
   * chunk that mentions this session_id. Used by the session-end
   * pipeline to find which project's transcripts.jsonl + auto-ingest
   * cursor to flush when a Lex/voice session closes. Returns null if
   * the session never wrote a chunk (empty session, ended too fast). */
  projectIdBySession(sessionId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT project_id FROM raw_chunks_meta
         WHERE session_id = ?
         ORDER BY timestamp_ms DESC
         LIMIT 1`,
      )
      .get(sessionId) as { project_id: string } | undefined;
    return row?.project_id ?? null;
  }

  /* Pull the most recent raw chunks for a single session (not whole
   * project) so the summarizer can produce a session-scoped summary
   * at end time. Returns rows newest-first; caller reverses for chrono
   * order before passing to the LLM. */
  recentRawChunksBySession(
    sessionId: string,
    limit: number,
  ): RawChunkRow[] {
    return this.db
      .prepare(
        `SELECT id, project_id, session_id, timestamp_ms, kind, role, byte_length
         FROM raw_chunks_meta
         WHERE session_id = ?
         ORDER BY timestamp_ms DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as RawChunkRow[];
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
