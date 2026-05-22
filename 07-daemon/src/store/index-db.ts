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
import { emitAwarenessEvent } from '../lex/awareness.js';

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
  /* Wave 2 carry-over #1: snapshot of the system-prompt version
   * (buildLexSystemPromptVersioned hash) at PTY spawn time so per-turn
   * LexThumbs can attach the version without recomputing. NULL on
   * legacy rows + non-Lex rows. */
  prompt_version?: string | null;
  /* Brainstorm-as-durable-primary-entity (2026-05-22, migration 033).
   * `runtime_mode` distinguishes legacy Lex-runs-as-CC-PTY brainstorms
   * from the new direct-LLM path that lets a brainstorm exist without
   * any Claude Code session backing it. `lifecycle_state` tracks the
   * brainstorm's current state independent of PTY existence.
   * `attached_worker_session_id` is the CC session UUID of the worker
   * currently bound (distinct from claude_session_id, which legacy
   * cc-pty brainstorms used for the Lex CC). Optional on the TS type
   * so legacy code paths that pre-date the migration keep compiling;
   * SQLite supplies defaults (cc-pty / idle) on read. */
  runtime_mode?: 'cc-pty' | 'direct-llm' | 'detached';
  lifecycle_state?: 'idle' | 'attached' | 'speaking' | 'ended';
  attached_worker_session_id?: string | null;
}

/* Brainstorm-as-durable-primary-entity (2026-05-22, migration 034).
 * lex_worker_expectation row. Open while closed_at IS NULL; the
 * expectation-supervisor evaluates it every 90s and either flips to
 * 'completed' / 'drifted' / 'superseded' / 'cancelled' once the
 * worker's recent activity has resolved one way or the other. */
export interface WorkerExpectationRow {
  id: string;
  brainstorm_id: string;
  anchor_id: string;
  expected_outcome: string;
  expected_files: string;
  expected_duration_ms: number | null;
  created_at: string;
  closed_at: string | null;
  closed_reason: 'completed' | 'drifted' | 'superseded' | 'cancelled' | null;
  last_evaluated_at: string | null;
  last_alignment_score: number | null;
  last_drift_summary: string | null;
  last_suggested_correction: string | null;
}

/* lex_feedback row. Inline-thumbs writes here keyed on the system-
 * prompt version so the prompt-tuning loop can aggregate up-rate
 * per revision over weeks. */
export interface LexFeedbackRow {
  id: string;
  turn_id: string;
  brainstorm_id: string | null;
  prompt_version: string;
  vote: 'up' | 'down';
  reason: string | null;
  created_at: string;
}

/* meeting_action_items row. Extracted from notes-summary artifacts at
 * the end of a meeting session; surfaced in MeetingDetail + seeds
 * reminders. */
export interface MeetingActionItemRow {
  id: string;
  meeting_id: string;
  text: string;
  assignee: string | null;
  due: string | null;
  reminder_id: string | null;
  status: 'open' | 'done' | 'dismissed' | 'superseded';
  source_turn_index: number | null;
  created_at: string;
  resolved_at: string | null;
}

/* audit_findings row. Cross-source surface that lint, the LLM
 * self-audit, the canary, the schema-regression suite, and the
 * random artifact sampler all write to. Wave 2 day 4 introduces the
 * lint + self-audit + user-flag writers. */
export interface AuditFindingRow {
  id: string;
  source: 'lint' | 'self-audit' | 'canary' | 'user-flag' | 'schema-regression' | 'janitor';
  severity: 'low' | 'medium' | 'high';
  page_slug: string | null;
  brainstorm_id: string | null;
  finding: string;
  detail: string | null;
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  created_at: string;
  resolved_at: string | null;
}

/* lex_retrieval_log row. Wave 3 Lane B step 34 (LX-12a). Records every
 * retrieval decision made during a Lex session so the dashboard can show
 * a trace of what was searched and whether internal or external retrieval
 * was used. Written by chunkSearch, the wiki recall hook, and the tool
 * gate middleware. */
export interface LexRetrievalLogRow {
  id: string;
  brainstorm_id: string | null;
  ts: string;
  query: string;
  kind: 'grep' | 'chunks' | 'wiki' | 'web';
  results_json: string | null;
  decision: string | null;
}

/* cross_session_injection_log row. Wave 3 Lane B step 38 (LX-15).
 * Audit trail for every POST /lex/inject-cross-session call; records
 * whether the attempt was accepted or rejected and why. */
export interface CrossSessionInjectionLogRow {
  id: string;
  ts: string;
  target_session: string;
  caller_label: string | null;
  text_preview: string;
  text_length: number;
  decision:
    | 'accepted'
    | 'rejected_auth'
    | 'rejected_allowlist'
    | 'rejected_pty'
    | 'shadow';
  reject_reason: string | null;
  brainstorm_id: string | null;
}

/* lex_backlog_items row (migration 026). Canonical store for the
 * autonomous supervisor backlog after the move off
 * c:/tmp/lex-backlog-queue.json. */
export interface BacklogItemRow {
  id: string;
  title: string;
  status: 'queued' | 'in-flight' | 'done' | 'parked';
  priority: string;
  added_at: string;
  injected_at: string | null;
  done_at: string | null;
  /** JSON-encoded array of short SHAs. */
  commit_shas: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  claimed_turn_uuid: string | null;
  anchor_id: string | null;
  notes: string | null;
}

export interface BacklogItemInsert {
  id: string;
  title: string;
  status: BacklogItemRow['status'];
  priority?: string;
  added_at: string;
  injected_at?: string | null;
  done_at?: string | null;
  commit_shas?: string | null;
  claimed_by?: string | null;
  claimed_at?: string | null;
  claimed_turn_uuid?: string | null;
  anchor_id?: string | null;
  notes?: string | null;
}

/* smart_compact_log row. SMART-COMPACT.md "Audit". One row per
 * smart-compact decision (evaluate fire / wrap injection / hard
 * ceiling / shadow). Dashboard panel reads this to surface a
 * timeline. */
export interface SmartCompactLogRow {
  id: string;
  ts: string;
  anchor_id: string | null;
  cc_session_id: string | null;
  caller: string;
  reason: string;
  action: 'fire' | 'wrap' | 'shadow' | 'noop';
  pre_ctx_pct: number | null;
  post_ctx_pct: number | null;
  summary_preview: string | null;
  /* Full payload the audit panel expands to show. Migration 023 adds
   * the column nullable; older rows have payload_text=null and the
   * panel falls back to summary_preview. */
  payload_text: string | null;
}

/* panic_log row. PANIC-BUTTON.md step 3. Audit row for every panic
 * button fire (dashboard click, Ctrl+Alt+. keybind, Lex tool call). */
export interface PanicLogRow {
  id: string;
  ts: string;
  target_anchor_id: string | null;
  target_pty_id: string | null;
  target_session_id: string | null;
  clicked_ms: number;
  caller: string;
  result: 'accepted' | 'pty_not_found' | 'no_target';
}

/* runtime_config row. Wave 2 day 4 step 19 (A15) pause-mode toggle
 * lives here so a daemon restart is not required to flip the gate.
 * Generic key/value JSON so future toggles (lint cadence override,
 * ingest model choice, etc.) reuse the table. */
export interface RuntimeConfigRow {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
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

/* lex_session row. The durable Lex brainstorm anchor introduced in
 * PLAN-lex-session-rewrite.md step 1. The id is daemon-owned and
 * surfaces as the canonical session identifier everywhere (Past
 * Sessions list, Stream Deck tile, Lex's own self-report). Every CC
 * jsonl ever produced under this anchor is recorded in
 * lex_transcript_ref so reopens can Read every prior transcript and
 * reconstruct the full conversation without summarisation. */
export interface LexSessionRow {
  id: string;
  created_ms: number;
  title: string | null;
  derived_title: string | null;
  status: 'live' | 'dormant';
  current_pty_id: string | null;
  cwd: string;
  /* Migration 025: persistent brainstorm-to-project binding. NULL =
   * unbound (cross-session-inject falls back to explicit
   * target_session as before). Non-null references project_session.id
   * so the inject path can resolve a target without judgment. */
  supervises_project_anchor_id?: string | null;
}

/* lex_transcript_ref row. Ordered list of CC jsonl pointers per
 * lex_session. ordering is 0-based and strictly increasing per
 * lex_session_id; the unique index on cc_session_id guarantees no
 * jsonl appears under two anchors. */
export interface LexTranscriptRefRow {
  id: number;
  lex_session_id: string;
  cc_session_id: string;
  transcript_path: string;
  started_ms: number;
  ended_ms: number | null;
  ordering: number;
}

/* project_session row. Durable per-project anchor identity, daemon-
 * owned, mirroring the lex_session pattern. cwd is the unique join
 * key against bridge presence files; project_slug is the folder
 * basename (with hash suffix on collision). Inserted dormant on
 * boot/seed; flipped live by the bridge presence resolver. */
export type SupervisionMode = 'polling' | 'event' | 'off';

export interface ProjectSessionRow {
  id: string;
  project_slug: string;
  cwd: string;
  title: string | null;
  status: 'live' | 'dormant';
  current_session_id: string | null;
  /* Prior current_session_id captured at the moment bridge-presence
   * flips this anchor onto a new CC session uuid (or back to dormant).
   * Lets cross-session-inject map a stale uuid back to its owning
   * anchor without a separate history table. Updated by
   * bridge-presence.reconcileBridgePresence (Fix 15). */
  previous_session_id?: string | null;
  current_bridge_id: string | null;
  current_pty_id: string | null;
  created_ms: number;
  last_seen_ms: number;
  /* EVENT-DRIVEN-SUPERVISION.md. 'polling' = legacy cron; 'event' =
   * daemon-driven push to Lex; 'off' = disabled. Migration 022 adds
   * the column with default 'polling'. Optional on write so legacy
   * call sites still compile; reads always populate the field. */
  supervision_mode?: SupervisionMode;
  /* Autonomous supervisor phase 3 (migration 027). Lease holder for
   * the auto-advance loop + a monotonically increasing epoch the
   * loop bumps each time it claims the lease. Used to fence stale
   * writes when a daemon restart or a second supervisor process
   * tries to act on a session another instance is already owning. */
  auto_advance_owner?: string | null;
  auto_advance_epoch?: number;
}

export interface AutoAdvanceLogRow {
  id: string;
  created_at: string;
  anchor_id: string | null;
  turn_uuid: string | null;
  item_id: string | null;
  mode: 'off' | 'shadow' | 'live';
  decision: 'shadow' | 'would-inject' | 'accepted' | 'skip' | 'error';
  reason: string | null;
  would_inject_preview: string | null;
  footer_status: string | null;
  footer_needs_attention: number | null;
  epoch: number | null;
}

export interface AutoAdvanceLogInsert {
  id: string;
  anchor_id: string | null;
  turn_uuid: string | null;
  item_id: string | null;
  mode: AutoAdvanceLogRow['mode'];
  decision: AutoAdvanceLogRow['decision'];
  reason?: string | null;
  would_inject_preview?: string | null;
  footer_status?: string | null;
  footer_needs_attention?: boolean | null;
  epoch?: number | null;
}

export const VALID_SUPERVISION_MODES: ReadonlySet<SupervisionMode> = new Set([
  'polling',
  'event',
  'off',
]);

/* runtime_config key that overrides the hard-coded 'polling' default
 * applied to anchor rows whose supervision_mode is NULL (legacy
 * pre-migration rows, project_session inserts that omit the field,
 * and the 5+ read-side fallbacks scattered across routes + the
 * event-driven supervisor). Setting this key to 'event' makes new
 * anchors auto-enroll into event-driven supervision instead of
 * needing a manual PATCH per anchor. The killswitch still flips to
 * 'polling' on overflow regardless of this default; the default
 * governs the steady state, not the safety valve.
 *
 * Parser tolerates leading/trailing whitespace + any case so a
 * shell `sqlite3 ... UPDATE runtime_config SET value='EVENT'` does
 * not silently bypass the validator and leave the daemon reading
 * garbage. Invalid values fall through to the hard-coded
 * 'polling' default so a bad write cannot ever flip the daemon
 * into an undefined mode. */
export const DEFAULT_SUPERVISION_MODE_CONFIG_KEY = 'default_supervision_mode';

export function parseSupervisionModeValue(
  raw: string | null | undefined,
): SupervisionMode | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (VALID_SUPERVISION_MODES.has(v as SupervisionMode)) {
    return v as SupervisionMode;
  }
  return null;
}

/* project_transcript_ref row. Ordered list of CC jsonl pointers per
 * project_session anchor. cc_session_id is UNIQUE across the table so
 * the same jsonl never lands under two anchors. closed_ms is NULL
 * while the underlying CC session is still live. */
export interface ProjectTranscriptRefRow {
  id: string;
  anchor_id: string;
  cc_session_id: string;
  jsonl_path: string;
  opened_ms: number;
  closed_ms: number | null;
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

      /* Wave 2 day 4 step 19 (A15): runtime configuration overrides.
       * Daemon reads this table first, env second, hardcoded default
       * last. Generic key/value so /system toggles (pause_mode today,
       * future cadence + provider toggles) reuse the same table. */
      CREATE TABLE IF NOT EXISTS runtime_config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_by TEXT
      );

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

  // ── voice_health_log ──────────────────────────────────────────
  /* Dashboard-side voice-output watchdog telemetry. The dashboard
   * batches rows on every 10s probe iteration that contains either
   * a failed check or the outcome of a heal attempt. Successful
   * idle ticks are not shipped. heal_attempt=0 means "check failed,
   * no heal yet"; 1 or 2 names the Nth heal attempt's outcome.
   * recovered=1 means the immediately-following check confirmed
   * the heal worked. */
  insertVoiceHealthRow(row: {
    ts_ms: number;
    check_kind: string;
    status: string;
    heal_attempt: number;
    recovered: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO voice_health_log
           (ts_ms, check_kind, status, heal_attempt, recovered)
         VALUES (@ts_ms, @check_kind, @status, @heal_attempt, @recovered)`,
      )
      .run(row);
  }

  listVoiceHealthRows(limit = 5): Array<{
    id: number;
    ts_ms: number;
    check_kind: string;
    status: string;
    heal_attempt: number;
    recovered: number;
  }> {
    const cap = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.db
      .prepare(
        `SELECT id, ts_ms, check_kind, status, heal_attempt, recovered
         FROM voice_health_log
         ORDER BY ts_ms DESC
         LIMIT ?`,
      )
      .all(cap) as Array<{
        id: number;
        ts_ms: number;
        check_kind: string;
        status: string;
        heal_attempt: number;
        recovered: number;
      }>;
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
      prompt_version: string | null;
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
    /* Keep brainstorm_sessions.turn_count in sync so the past-sessions
     * list and the empty-row filter (listBrainstormsFiltered) can
     * decide substance without a JOIN on every read. Recompute the
     * full count rather than incrementing so INSERT OR REPLACE on an
     * existing primary key stays correct (no double-count). */
    this.db
      .prepare(
        `UPDATE brainstorm_sessions
           SET turn_count = (
             SELECT COUNT(*) FROM brainstorm_chunks WHERE brainstorm_id = ?
           )
         WHERE id = ?`,
      )
      .run(row.brainstorm_id, row.brainstorm_id);
  }

  countBrainstormChunks(brainstormId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM brainstorm_chunks WHERE brainstorm_id = ?`)
      .get(brainstormId) as { n: number };
    return r.n;
  }

  /* Next monotonically-increasing turn_index for a brainstorm. Used by
   * the live voice WS path to land each user / assistant turn the
   * moment it arrives instead of waiting on the session-end pipeline.
   * COALESCE so the first turn lands at index 0. */
  nextTurnIndex(brainstormId: string): number {
    const r = this.db
      .prepare(
        `SELECT COALESCE(MAX(turn_index), -1) + 1 AS n
           FROM brainstorm_chunks WHERE brainstorm_id = ?`,
      )
      .get(brainstormId) as { n: number };
    return r.n;
  }

  listBrainstormChunks(
    brainstormId: string,
    limit = 1000,
    opts: { order?: 'asc' | 'desc'; offset?: number } = {},
  ): BrainstormChunkRow[] {
    const order = opts.order === 'desc' ? 'DESC' : 'ASC';
    const offset = Math.max(0, opts.offset ?? 0);
    return this.db
      .prepare(
        `SELECT * FROM brainstorm_chunks WHERE brainstorm_id = ? ORDER BY turn_index ${order} LIMIT ? OFFSET ?`,
      )
      .all(brainstormId, limit, offset) as BrainstormChunkRow[];
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

  /* Wave 2 day 4 audit_findings helpers (steps 15, 16, 17, 18).
   * insertAuditFinding is the write path for lint, the LLM self-audit,
   * canary, schema-regression, and the user-flag "this looks wrong"
   * surface. listAuditFindings drives the dashboard panel; the update
   * helper handles ack / resolve / dismiss transitions. Inserts use
   * INSERT OR IGNORE keyed on a content-derived id when the caller
   * passes one so re-running lint does not produce duplicates of the
   * same finding for the same page. */
  insertAuditFinding(row: {
    id: string;
    source: 'lint' | 'self-audit' | 'canary' | 'user-flag' | 'schema-regression' | 'janitor';
    severity: 'low' | 'medium' | 'high';
    page_slug?: string | null;
    brainstorm_id?: string | null;
    finding: string;
    detail?: string | null;
    status?: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  }): void {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO audit_findings
           (id, source, severity, page_slug, brainstorm_id, finding, detail, status)
         VALUES (@id, @source, @severity, @page_slug, @brainstorm_id, @finding, @detail, @status)`,
      )
      .run({
        page_slug: null,
        brainstorm_id: null,
        detail: null,
        status: 'open',
        ...row,
      });
    /* Wave 2 carry-over #2: producer hook for the L1 awareness
     * broadcaster. Only emit when a new row landed (changes > 0) so
     * idempotent INSERT OR IGNORE replays do not spam Lex. Canary
     * source maps to the dedicated kind so meeting-mode + budget
     * gating treat it the same as the spec's other push-on-change
     * signals. */
    if (info.changes > 0) {
      const kind: 'audit-finding' | 'canary-fail' =
        row.source === 'canary' ? 'canary-fail' : 'audit-finding';
      const label = `${row.severity}:${row.page_slug ?? row.source}`;
      try {
        emitAwarenessEvent({
          kind,
          label,
          ...(row.brainstorm_id ? { brainstorm_id: row.brainstorm_id } : {}),
          detail: { finding: row.finding, source: row.source },
        });
      } catch {
        /* awareness emit is best-effort; never break a DB write. */
      }
    }
  }

  listAuditFindings(opts: {
    status?: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
    source?: 'lint' | 'self-audit' | 'canary' | 'user-flag' | 'schema-regression' | 'janitor';
    severity?: 'low' | 'medium' | 'high';
    page_slug?: string;
    limit?: number;
  } = {}): AuditFindingRow[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.status) {
      where.push(`status = ?`);
      params.push(opts.status);
    }
    if (opts.source) {
      where.push(`source = ?`);
      params.push(opts.source);
    }
    if (opts.severity) {
      where.push(`severity = ?`);
      params.push(opts.severity);
    }
    if (opts.page_slug) {
      where.push(`page_slug = ?`);
      params.push(opts.page_slug);
    }
    const sql =
      `SELECT * FROM audit_findings` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      /* High severity bubbles to the top so the panel surfaces the
       * urgent items first; ties broken by recency. */
      ` ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as AuditFindingRow[];
  }

  updateAuditFindingStatus(
    id: string,
    status: 'open' | 'acknowledged' | 'resolved' | 'dismissed',
  ): AuditFindingRow | null {
    const isTerminal = status === 'resolved' || status === 'dismissed';
    this.db
      .prepare(
        `UPDATE audit_findings SET status = ?, resolved_at = ? WHERE id = ?`,
      )
      .run(
        status,
        isTerminal ? new Date().toISOString() : null,
        id,
      );
    return (
      (this.db
        .prepare(`SELECT * FROM audit_findings WHERE id = ?`)
        .get(id) as AuditFindingRow | undefined) ?? null
    );
  }

  /* runtime_config helpers. The daemon reads via getRuntimeConfig
   * before falling back to env / defaults. Writes from /system land
   * via setRuntimeConfig + go through here so the daemon does not
   * need a restart to flip the gate. */
  getRuntimeConfig(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM runtime_config WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /* Resolve the operator-configured default supervision_mode for
   * new / null-mode anchors. Falls back to 'polling' when the
   * runtime_config row is unset or carries an unparseable value.
   * Centralised so every read-side fallback and the
   * project_session insert default agree. */
  getDefaultSupervisionMode(): SupervisionMode {
    const raw = this.getRuntimeConfig(DEFAULT_SUPERVISION_MODE_CONFIG_KEY);
    return parseSupervisionModeValue(raw) ?? 'polling';
  }

  setRuntimeConfig(key: string, value: string, updatedBy?: string): void {
    this.db
      .prepare(
        `INSERT INTO runtime_config (key, value, updated_at, updated_by)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(key, value, updatedBy ?? null);
  }

  listRuntimeConfig(): RuntimeConfigRow[] {
    return this.db
      .prepare(`SELECT * FROM runtime_config ORDER BY key`)
      .all() as RuntimeConfigRow[];
  }

  /* Wave 2 day 5 step 24 (LX-5 / B5) lex_feedback helpers. */
  insertLexFeedback(row: {
    id: string;
    turn_id: string;
    brainstorm_id?: string | null;
    prompt_version: string;
    vote: 'up' | 'down';
    reason?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO lex_feedback
           (id, turn_id, brainstorm_id, prompt_version, vote, reason)
         VALUES (@id, @turn_id, @brainstorm_id, @prompt_version, @vote, @reason)`,
      )
      .run({
        brainstorm_id: null,
        reason: null,
        ...row,
      });
  }

  listLexFeedback(opts: {
    prompt_version?: string;
    brainstorm_id?: string;
    vote?: 'up' | 'down';
    limit?: number;
  } = {}): LexFeedbackRow[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.prompt_version) {
      where.push(`prompt_version = ?`);
      params.push(opts.prompt_version);
    }
    if (opts.brainstorm_id) {
      where.push(`brainstorm_id = ?`);
      params.push(opts.brainstorm_id);
    }
    if (opts.vote) {
      where.push(`vote = ?`);
      params.push(opts.vote);
    }
    const sql =
      `SELECT * FROM lex_feedback` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as LexFeedbackRow[];
  }

  /* Per-prompt-version up-rate. Drives the LX-1 prompt loop telemetry. */
  lexFeedbackUpRate(promptVersion: string): {
    up: number;
    down: number;
    total: number;
    up_rate: number;
  } {
    const r = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN vote = 'up' THEN 1 ELSE 0 END) AS up,
           SUM(CASE WHEN vote = 'down' THEN 1 ELSE 0 END) AS down,
           COUNT(*) AS total
         FROM lex_feedback
         WHERE prompt_version = ?`,
      )
      .get(promptVersion) as { up: number; down: number; total: number };
    const up = Number(r.up ?? 0);
    const down = Number(r.down ?? 0);
    const total = Number(r.total ?? 0);
    return { up, down, total, up_rate: total > 0 ? up / total : 0 };
  }

  /* Wave 2 day 5 step 24a meeting_action_items helpers. */
  insertMeetingActionItem(row: {
    id: string;
    meeting_id: string;
    text: string;
    assignee?: string | null;
    due?: string | null;
    reminder_id?: string | null;
    status?: 'open' | 'done' | 'dismissed' | 'superseded';
    source_turn_index?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO meeting_action_items
           (id, meeting_id, text, assignee, due, reminder_id, status, source_turn_index)
         VALUES (@id, @meeting_id, @text, @assignee, @due, @reminder_id, @status, @source_turn_index)`,
      )
      .run({
        assignee: null,
        due: null,
        reminder_id: null,
        status: 'open',
        source_turn_index: null,
        ...row,
      });
  }

  listMeetingActionItems(meetingId: string): MeetingActionItemRow[] {
    return this.db
      .prepare(
        `SELECT * FROM meeting_action_items WHERE meeting_id = ? ORDER BY created_at ASC`,
      )
      .all(meetingId) as MeetingActionItemRow[];
  }

  updateMeetingActionItemStatus(
    id: string,
    status: 'open' | 'done' | 'dismissed' | 'superseded',
  ): MeetingActionItemRow | null {
    const isTerminal = status !== 'open';
    this.db
      .prepare(
        `UPDATE meeting_action_items SET status = ?, resolved_at = ? WHERE id = ?`,
      )
      .run(
        status,
        isTerminal ? new Date().toISOString() : null,
        id,
      );
    return (
      (this.db
        .prepare(`SELECT * FROM meeting_action_items WHERE id = ?`)
        .get(id) as MeetingActionItemRow | undefined) ?? null
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
    /* Default false: hide rows with zero turns AND no audio AND no
     * distilled summary. These are typically daemon-restart orphans
     * or auto-spawn shells that never got used. Pass true to surface
     * them (admin / debug). */
    includeEmpty?: boolean;
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
    if (!opts.includeEmpty) {
      where.push(
        `(turn_count > 0 OR audio_path IS NOT NULL OR distilled_at IS NOT NULL)`,
      );
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
    /* Wave 2 carry-over #2: producer hook for the awareness
     * broadcaster's draft-auto-dropped signal. Only fires on the
     * actual pending -> auto-dropped transition; manual discards
     * are scoped to other kinds and would otherwise spam Lex. */
    if (
      patch.status === 'auto-dropped' &&
      existing.status !== 'auto-dropped'
    ) {
      try {
        emitAwarenessEvent({
          kind: 'draft-auto-dropped',
          label: `${merged.page_slug ?? id}`,
          detail: {
            draft_id: id,
            page_title: merged.page_title,
            resolved_by: merged.resolved_by,
          },
        });
      } catch {
        /* awareness emit is best-effort */
      }
    }
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
    /* Migration 033 columns (runtime_mode, lifecycle_state,
     * attached_worker_session_id) are NOT enumerated here so legacy
     * spawnLex inserts keep their SQLite-defaulted values
     * (cc-pty / idle / null). Standalone brainstorms set those
     * explicitly via the followup updateBrainstorm call inside
     * createStandaloneBrainstorm so the same INSERT path serves both
     * legacy and direct-llm without diverging schemas. */
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
    /* Targeted UPDATE rather than INSERT OR REPLACE. The latter
     * silently clobbered every column not enumerated in
     * insertBrainstorm's INSERT statement (audio_path,
     * distilled_at, project_slug, kind, attendees, etc.) which got
     * exposed once the long-tail reaper started checking those
     * columns to decide cruft vs substance. */
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') continue;
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(v as string | number | null);
    }
    if (sets.length > 0) {
      params.push(id);
      this.db
        .prepare(
          `UPDATE brainstorm_sessions SET ${sets.join(', ')} WHERE id = ?`,
        )
        .run(...params);
    }
    return this.getBrainstorm(id);
  }

  getBrainstorm(id: string): BrainstormSessionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM brainstorm_sessions WHERE id = ?`)
        .get(id) as BrainstormSessionRow | undefined) ?? null
    );
  }

  /* Hard-delete a brainstorm row. Used by the boot reaper to drop
   * orphan auto-spawn shells (zero turns, no audio, no distilled
   * summary). Substantive rows are marked status='ended' instead.
   * brainstorm_chunks rows for the id are removed first so the
   * FK declaration in migration 003 stays satisfied even when
   * pragma foreign_keys is on. */
  deleteBrainstorm(id: string): void {
    this.db.prepare(`DELETE FROM brainstorm_chunks WHERE brainstorm_id = ?`).run(id);
    this.db.prepare(`DELETE FROM brainstorm_sessions WHERE id = ?`).run(id);
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

  /* Brainstorm-as-durable-primary-entity (2026-05-22, migration 034).
   * lex_worker_expectation row helpers. Drives the active polling-
   * with-expectations supervisor: Lex records what it told the
   * worker to do, the 90s tick reads the worker's jsonl tail and
   * asks the LLM "does this align?", and on drift fires lex-attention. */
  insertWorkerExpectation(row: {
    id: string;
    brainstorm_id: string;
    anchor_id: string;
    expected_outcome: string;
    expected_files?: string[];
    expected_duration_ms?: number | null;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO lex_worker_expectation
             (id, brainstorm_id, anchor_id, expected_outcome,
              expected_files, expected_duration_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.brainstorm_id,
          row.anchor_id,
          row.expected_outcome,
          JSON.stringify(row.expected_files ?? []),
          row.expected_duration_ms ?? null,
        );
    } catch {
      /* table missing pre-migration 034; never crash the caller */
    }
  }

  listOpenWorkerExpectations(
    opts: { brainstormId?: string; limit?: number } = {},
  ): WorkerExpectationRow[] {
    const limit = opts.limit ?? 50;
    try {
      if (opts.brainstormId) {
        return this.db
          .prepare(
            `SELECT * FROM lex_worker_expectation
              WHERE closed_at IS NULL AND brainstorm_id = ?
              ORDER BY created_at DESC LIMIT ?`,
          )
          .all(opts.brainstormId, limit) as WorkerExpectationRow[];
      }
      return this.db
        .prepare(
          `SELECT * FROM lex_worker_expectation
            WHERE closed_at IS NULL
            ORDER BY created_at ASC LIMIT ?`,
        )
        .all(limit) as WorkerExpectationRow[];
    } catch {
      return [];
    }
  }

  updateWorkerExpectationEvaluation(
    id: string,
    patch: {
      alignment_score: number | null;
      drift_summary: string | null;
      suggested_correction: string | null;
    },
  ): void {
    try {
      this.db
        .prepare(
          `UPDATE lex_worker_expectation
             SET last_evaluated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 last_alignment_score = ?,
                 last_drift_summary = ?,
                 last_suggested_correction = ?
           WHERE id = ?`,
        )
        .run(
          patch.alignment_score,
          patch.drift_summary,
          patch.suggested_correction,
          id,
        );
    } catch {
      /* observability only */
    }
  }

  closeWorkerExpectation(
    id: string,
    reason: 'completed' | 'drifted' | 'superseded' | 'cancelled',
  ): void {
    try {
      this.db
        .prepare(
          `UPDATE lex_worker_expectation
             SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                 closed_reason = ?
           WHERE id = ? AND closed_at IS NULL`,
        )
        .run(reason, id);
    } catch {
      /* observability only */
    }
  }

  /* Brainstorm-as-durable-primary-entity (2026-05-22, migration 033).
   * Resolve the brainstorm that has bound `ccSessionId` as its worker
   * via attachWorkerSession. Used by the worker SessionStart handoff
   * so a fresh CC session picks up the brainstorm's accumulated
   * context on its first turn. Returns the most-recently-started row
   * when more than one brainstorm has somehow latched the same
   * worker (should be unique in practice). */
  getBrainstormByAttachedWorker(
    ccSessionId: string,
  ): BrainstormSessionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM brainstorm_sessions
            WHERE attached_worker_session_id = ?
            ORDER BY started_ms DESC LIMIT 1`,
        )
        .get(ccSessionId) as BrainstormSessionRow | undefined) ?? null
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

  /* ── lex_session ────────────────────────────────────────────────
   * New session model from PLAN-lex-session-rewrite.md. lex_session
   * is the durable anchor; lex_transcript_ref is the ordered list of
   * CC jsonl pointers per anchor. The legacy brainstorm_sessions
   * table is still populated by the old code path during the
   * migration window; both feeds coexist until the rip-out step. */
  insertLexSession(row: LexSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO lex_session
           (id, created_ms, title, derived_title, status, current_pty_id, cwd, supervises_project_anchor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.created_ms,
        row.title,
        row.derived_title,
        row.status,
        row.current_pty_id,
        row.cwd,
        row.supervises_project_anchor_id ?? null,
      );
  }

  /* Phase C: bind / unbind a brainstorm anchor to a project anchor.
   * The cross-session-inject fallback resolver consults this column
   * when Lex omits target_session, so the operator can pick the
   * project up front and never re-state it inside Lex prompts. Pass
   * null to clear an existing binding. */
  setLexSessionSupervises(
    lexAnchorId: string,
    projectAnchorId: string | null,
  ): LexSessionRow | null {
    this.db
      .prepare(
        `UPDATE lex_session
           SET supervises_project_anchor_id = ?
         WHERE id = ?`,
      )
      .run(projectAnchorId, lexAnchorId);
    return this.getLexSession(lexAnchorId);
  }

  updateLexSession(
    id: string,
    patch: Partial<Omit<LexSessionRow, 'id' | 'created_ms'>>,
  ): LexSessionRow | null {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(v as string | number | null);
    }
    if (sets.length === 0) return this.getLexSession(id);
    params.push(id);
    this.db
      .prepare(`UPDATE lex_session SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return this.getLexSession(id);
  }

  getLexSession(id: string): LexSessionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM lex_session WHERE id = ?`)
        .get(id) as LexSessionRow | undefined) ?? null
    );
  }

  listLexSessions(opts: {
    status?: 'live' | 'dormant';
    limit?: number;
  } = {}): LexSessionRow[] {
    const limit = opts.limit ?? 50;
    if (opts.status) {
      return this.db
        .prepare(
          `SELECT * FROM lex_session WHERE status = ? ORDER BY created_ms DESC LIMIT ?`,
        )
        .all(opts.status, limit) as LexSessionRow[];
    }
    return this.db
      .prepare(`SELECT * FROM lex_session ORDER BY created_ms DESC LIMIT ?`)
      .all(limit) as LexSessionRow[];
  }

  deleteLexSession(id: string): void {
    /* ON DELETE CASCADE on lex_transcript_ref drops the children. */
    this.db.prepare(`DELETE FROM lex_session WHERE id = ?`).run(id);
  }

  /* ── lex_transcript_ref ────────────────────────────────────────── */
  insertLexTranscriptRef(
    row: Omit<LexTranscriptRefRow, 'id'>,
  ): LexTranscriptRefRow {
    const r = this.db
      .prepare(
        `INSERT INTO lex_transcript_ref
           (lex_session_id, cc_session_id, transcript_path, started_ms, ended_ms, ordering)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.lex_session_id,
        row.cc_session_id,
        row.transcript_path,
        row.started_ms,
        row.ended_ms,
        row.ordering,
      );
    return { id: Number(r.lastInsertRowid), ...row };
  }

  updateLexTranscriptRef(
    id: number,
    patch: Partial<Pick<LexTranscriptRefRow, 'ended_ms'>>,
  ): void {
    const sets: string[] = [];
    const params: Array<number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(v as number | null);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db
      .prepare(`UPDATE lex_transcript_ref SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
  }

  listLexTranscriptRefs(lexSessionId: string): LexTranscriptRefRow[] {
    return this.db
      .prepare(
        `SELECT * FROM lex_transcript_ref WHERE lex_session_id = ?
         ORDER BY ordering ASC, started_ms ASC`,
      )
      .all(lexSessionId) as LexTranscriptRefRow[];
  }

  getLexTranscriptRefByCc(ccSessionId: string): LexTranscriptRefRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM lex_transcript_ref WHERE cc_session_id = ?`)
        .get(ccSessionId) as LexTranscriptRefRow | undefined) ?? null
    );
  }

  countLexTranscriptRefs(lexSessionId: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM lex_transcript_ref WHERE lex_session_id = ?`,
      )
      .get(lexSessionId) as { n: number } | undefined;
    return r?.n ?? 0;
  }

  /* ── project_session ────────────────────────────────────────────
   * Durable project anchor model from docs/spec/PROJECT-ANCHORS.md.
   * Mirrors the lex_session pattern. cwd is the unique join key. */
  insertProjectSession(row: ProjectSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO project_session
           (id, project_slug, cwd, title, status,
            current_session_id, current_bridge_id, current_pty_id,
            created_ms, last_seen_ms, supervision_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.project_slug,
        row.cwd,
        row.title,
        row.status,
        row.current_session_id,
        row.current_bridge_id,
        row.current_pty_id,
        row.created_ms,
        row.last_seen_ms,
        row.supervision_mode ?? this.getDefaultSupervisionMode(),
      );
  }

  updateProjectSession(
    id: string,
    patch: Partial<Omit<ProjectSessionRow, 'id' | 'created_ms'>>,
  ): ProjectSessionRow | null {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(v as string | number | null);
    }
    if (sets.length === 0) return this.getProjectSession(id);
    params.push(id);
    this.db
      .prepare(`UPDATE project_session SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return this.getProjectSession(id);
  }

  getProjectSession(id: string): ProjectSessionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM project_session WHERE id = ?`)
        .get(id) as ProjectSessionRow | undefined) ?? null
    );
  }

  getProjectSessionByCwd(cwd: string): ProjectSessionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM project_session WHERE cwd = ?`)
        .get(cwd) as ProjectSessionRow | undefined) ?? null
    );
  }

  /* Fix 15 — anchor lookup by CC session uuid.
   *
   * Returns the project_session row whose current_session_id matches
   * `sessionId` (live anchor) or whose previous_session_id matches
   * (anchor that flipped onto a new uuid since the caller last cached
   * one). Used by /lex/inject-cross-session to redirect injects that
   * target a stale uuid onto the anchor's live session, and to surface
   * bound-anchor-dormant rejects when the anchor has gone away. */
  findProjectSessionBySessionId(sessionId: string): ProjectSessionRow | null {
    if (!sessionId) return null;
    return (
      (this.db
        .prepare(
          `SELECT * FROM project_session
             WHERE current_session_id = ? OR previous_session_id = ?
             ORDER BY status = 'live' DESC, last_seen_ms DESC
             LIMIT 1`,
        )
        .get(sessionId, sessionId) as ProjectSessionRow | undefined) ?? null
    );
  }

  listProjectSessions(opts: {
    status?: 'live' | 'dormant';
    limit?: number;
  } = {}): ProjectSessionRow[] {
    const limit = opts.limit ?? 200;
    if (opts.status) {
      return this.db
        .prepare(
          `SELECT * FROM project_session WHERE status = ?
             ORDER BY last_seen_ms DESC LIMIT ?`,
        )
        .all(opts.status, limit) as ProjectSessionRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM project_session
           ORDER BY status = 'live' DESC, last_seen_ms DESC LIMIT ?`,
      )
      .all(limit) as ProjectSessionRow[];
  }

  deleteProjectSession(id: string): void {
    /* ON DELETE CASCADE on project_transcript_ref drops the children. */
    this.db.prepare(`DELETE FROM project_session WHERE id = ?`).run(id);
  }

  /* ── project_transcript_ref ──────────────────────────────────── */
  insertProjectTranscriptRef(row: ProjectTranscriptRefRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO project_transcript_ref
           (id, anchor_id, cc_session_id, jsonl_path, opened_ms, closed_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.anchor_id,
        row.cc_session_id,
        row.jsonl_path,
        row.opened_ms,
        row.closed_ms,
      );
  }

  closeProjectTranscriptRef(ccSessionId: string, closedMs: number): void {
    this.db
      .prepare(
        `UPDATE project_transcript_ref
           SET closed_ms = ?
         WHERE cc_session_id = ? AND closed_ms IS NULL`,
      )
      .run(closedMs, ccSessionId);
  }

  listProjectTranscriptRefs(anchorId: string): ProjectTranscriptRefRow[] {
    return this.db
      .prepare(
        `SELECT * FROM project_transcript_ref WHERE anchor_id = ?
           ORDER BY opened_ms ASC`,
      )
      .all(anchorId) as ProjectTranscriptRefRow[];
  }

  getProjectTranscriptRefByCc(
    ccSessionId: string,
  ): ProjectTranscriptRefRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM project_transcript_ref WHERE cc_session_id = ?`)
        .get(ccSessionId) as ProjectTranscriptRefRow | undefined) ?? null
    );
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

  // ── lex_retrieval_log (Wave 3 Lane B step 34 / LX-12a) ──────────
  /* Insert a retrieval trace row. Called by chunkSearch, wiki recall
   * hook, and the tool gate middleware. Best-effort; never throws. */
  insertRetrievalLog(row: {
    id: string;
    brainstorm_id?: string | null;
    query: string;
    kind: 'grep' | 'chunks' | 'wiki' | 'web';
    results_json?: string | null;
    decision?: string | null;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO lex_retrieval_log
             (id, brainstorm_id, query, kind, results_json, decision)
           VALUES (@id, @brainstorm_id, @query, @kind, @results_json, @decision)`,
        )
        .run({
          brainstorm_id: null,
          results_json: null,
          decision: null,
          ...row,
        });
    } catch {
      /* table may not exist if migration 015 has not run yet; silently skip */
    }
  }

  listRetrievalLogs(opts: {
    brainstorm_id?: string;
    kind?: 'grep' | 'chunks' | 'wiki' | 'web';
    limit?: number;
  } = {}): LexRetrievalLogRow[] {
    try {
      const limit = Math.min(500, Math.max(1, opts.limit ?? 50));
      if (opts.brainstorm_id) {
        const rows = this.db
          .prepare(
            `SELECT * FROM lex_retrieval_log
             WHERE brainstorm_id = ?
             ORDER BY ts DESC LIMIT ?`,
          )
          .all(opts.brainstorm_id, limit);
        return rows as LexRetrievalLogRow[];
      }
      if (opts.kind) {
        const rows = this.db
          .prepare(
            `SELECT * FROM lex_retrieval_log
             WHERE kind = ?
             ORDER BY ts DESC LIMIT ?`,
          )
          .all(opts.kind, limit);
        return rows as LexRetrievalLogRow[];
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM lex_retrieval_log ORDER BY ts DESC LIMIT ?`,
        )
        .all(limit);
      return rows as LexRetrievalLogRow[];
    } catch {
      /* table may not exist yet */
      return [];
    }
  }

  /** Write one cross-session injection audit record. Silently swallowed if
   * the table doesn't exist yet (migration 017 not run). */
  insertCrossSessionLog(row: {
    id: string;
    target_session: string;
    caller_label?: string | null;
    text_preview: string;
    text_length: number;
    decision:
      | 'accepted'
      | 'rejected_auth'
      | 'rejected_allowlist'
      | 'rejected_pty'
      | 'shadow'
      | 'redirected'
      | 'dispatched_dead_session'
      | 'rejected_anchor_dormant'
      | 'no_deliverable_bridge';
    reject_reason?: string | null;
    brainstorm_id?: string | null;
    /* Fix 15 C3 — full inject text, populated only when the audit
     * row is destined for replay by smart-compact resume
     * (decision='dispatched_dead_session'). Nullable on all other
     * decisions to keep audit storage bounded. Requires migration
     * 030 to be present; silently nulled if the column is missing. */
    payload_text?: string | null;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO cross_session_injection_log
             (id, target_session, caller_label, text_preview, text_length, decision, reject_reason, brainstorm_id, payload_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.target_session,
          row.caller_label ?? null,
          row.text_preview,
          row.text_length,
          row.decision,
          row.reject_reason ?? null,
          row.brainstorm_id ?? null,
          row.payload_text ?? null,
        );
    } catch {
      /* table or column may not exist yet; not fatal */
    }
  }

  /* Fix 15 C3 — parked-inject replay lookup. Returns the most recent
   * dispatched_dead_session audit rows that name `anchorId` in their
   * structured reject_reason payload and still carry a non-null
   * payload_text, capped at `limit` (default 3) and bounded to the
   * last `sinceMs` ms (default 5 min). Smart-compact's resume hook
   * calls this just before firing the resume summary so any injects
   * that landed while the anchor was dormant get re-delivered to the
   * fresh session uuid. */
  findParkedInjectsForAnchor(
    anchorId: string,
    opts: { sinceMs?: number; limit?: number; nowMs?: number } = {},
  ): Array<{
    id: string;
    target_session: string;
    caller_label: string | null;
    payload_text: string;
    ts: string;
  }> {
    if (!anchorId) return [];
    const sinceMs = opts.sinceMs ?? 5 * 60 * 1000;
    const limit = opts.limit ?? 3;
    const nowMs = opts.nowMs ?? Date.now();
    const cutoffIso = new Date(nowMs - sinceMs).toISOString();
    try {
      const rows = this.db
        .prepare(
          `SELECT id, target_session, caller_label, payload_text, ts
             FROM cross_session_injection_log
            WHERE decision = 'dispatched_dead_session'
              AND payload_text IS NOT NULL
              AND ts >= ?
              AND reject_reason LIKE ?
            ORDER BY ts ASC
            LIMIT ?`,
        )
        .all(cutoffIso, `%"anchor_id":"${anchorId}"%`, limit) as Array<{
          id: string;
          target_session: string;
          caller_label: string | null;
          payload_text: string;
          ts: string;
        }>;
      return rows;
    } catch {
      return [];
    }
  }

  /* Fix 15 C3 — mark a parked inject as replayed so the next resume
   * window doesn't double-fire it. Rewrites decision to 'accepted'
   * and amends reject_reason to record the replay context. */
  markParkedInjectReplayed(
    id: string,
    replayedToSession: string,
  ): void {
    try {
      this.db
        .prepare(
          `UPDATE cross_session_injection_log
              SET decision = 'accepted',
                  reject_reason = COALESCE(reject_reason, '') || ?
            WHERE id = ?`,
        )
        .run(`;replayed_to=${replayedToSession}`, id);
    } catch {
      /* not fatal — replay already fired */
    }
  }

  /** Write one smart-compact audit record. Swallowed if migration 021
   * has not been applied yet. */
  insertSmartCompactLog(row: {
    id: string;
    anchor_id: string | null;
    cc_session_id: string | null;
    caller: string;
    reason: string;
    action: 'fire' | 'wrap' | 'shadow' | 'noop';
    pre_ctx_pct: number | null;
    post_ctx_pct?: number | null;
    summary_preview?: string | null;
    payload_text?: string | null;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO smart_compact_log
             (id, anchor_id, cc_session_id, caller, reason, action,
              pre_ctx_pct, post_ctx_pct, summary_preview, payload_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.anchor_id,
          row.cc_session_id,
          row.caller,
          row.reason,
          row.action,
          row.pre_ctx_pct,
          row.post_ctx_pct ?? null,
          row.summary_preview ?? null,
          row.payload_text ?? null,
        );
    } catch {
      /* table may not exist yet; not fatal */
    }
  }

  listRecentSmartCompacts(limit: number = 20): SmartCompactLogRow[] {
    try {
      const capped = Math.min(200, Math.max(1, limit));
      return this.db
        .prepare(`SELECT * FROM smart_compact_log ORDER BY ts DESC LIMIT ?`)
        .all(capped) as SmartCompactLogRow[];
    } catch {
      return [];
    }
  }

  countSmartCompactsForAnchor(anchorId: string): number {
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM smart_compact_log WHERE anchor_id = ?`,
        )
        .get(anchorId) as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Write one panic-button audit record. Swallowed if migration 020
   * has not been applied yet. */
  insertPanicLog(row: {
    id: string;
    target_anchor_id: string | null;
    target_pty_id: string | null;
    target_session_id: string | null;
    clicked_ms: number;
    caller: string;
    result: 'accepted' | 'pty_not_found' | 'no_target';
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO panic_log
             (id, target_anchor_id, target_pty_id, target_session_id,
              clicked_ms, caller, result)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.target_anchor_id,
          row.target_pty_id,
          row.target_session_id,
          row.clicked_ms,
          row.caller,
          row.result,
        );
    } catch {
      /* table may not exist yet; not fatal */
    }
  }

  listRecentPanics(limit: number = 20): PanicLogRow[] {
    try {
      const capped = Math.min(200, Math.max(1, limit));
      return this.db
        .prepare(`SELECT * FROM panic_log ORDER BY ts DESC LIMIT ?`)
        .all(capped) as PanicLogRow[];
    } catch {
      return [];
    }
  }

  listCrossSessionLogs(opts: {
    target_session?: string;
    decision?:
      | 'accepted'
      | 'rejected_auth'
      | 'rejected_allowlist'
      | 'rejected_pty'
      | 'shadow';
    caller_label?: string;
    limit?: number;
  } = {}): CrossSessionInjectionLogRow[] {
    try {
      const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
      const wheres: string[] = [];
      const params: unknown[] = [];
      if (opts.target_session) {
        wheres.push('target_session = ?');
        params.push(opts.target_session);
      }
      if (opts.decision) {
        wheres.push('decision = ?');
        params.push(opts.decision);
      }
      if (opts.caller_label) {
        wheres.push('caller_label = ?');
        params.push(opts.caller_label);
      }
      const clause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
      params.push(limit);
      const rows = this.db
        .prepare(
          `SELECT * FROM cross_session_injection_log ${clause}
           ORDER BY ts DESC LIMIT ?`,
        )
        .all(...params);
      return rows as CrossSessionInjectionLogRow[];
    } catch {
      return [];
    }
  }

  /* ─── Lex backlog (migration 026) ─────────────────────────────
   *
   * Canonical store for the autonomous supervisor backlog. Moved
   * off c:/tmp/lex-backlog-queue.json so the atomic claim primitive
   * gets real transaction semantics under concurrent callers.
   */

  insertBacklogItem(row: BacklogItemInsert): void {
    this.db
      .prepare(
        `INSERT INTO lex_backlog_items
           (id, title, status, priority, added_at, injected_at,
            done_at, commit_shas, claimed_by, claimed_at,
            claimed_turn_uuid, anchor_id, notes)
         VALUES (@id, @title, @status, @priority, @added_at,
                 @injected_at, @done_at, @commit_shas, @claimed_by,
                 @claimed_at, @claimed_turn_uuid, @anchor_id,
                 @notes)`,
      )
      .run({
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority ?? 'polish',
        added_at: row.added_at,
        injected_at: row.injected_at ?? null,
        done_at: row.done_at ?? null,
        commit_shas: row.commit_shas ?? null,
        claimed_by: row.claimed_by ?? null,
        claimed_at: row.claimed_at ?? null,
        claimed_turn_uuid: row.claimed_turn_uuid ?? null,
        anchor_id: row.anchor_id ?? null,
        notes: row.notes ?? null,
      });
  }

  upsertBacklogItem(row: BacklogItemInsert): void {
    /* Used by the one-shot JSON seeder so a re-run does not crash
     * on PRIMARY KEY collisions. Production callers should go
     * through insertBacklogItem; upsert is a seeding tool. */
    this.db
      .prepare(
        `INSERT INTO lex_backlog_items
           (id, title, status, priority, added_at, injected_at,
            done_at, commit_shas, claimed_by, claimed_at,
            claimed_turn_uuid, anchor_id, notes)
         VALUES (@id, @title, @status, @priority, @added_at,
                 @injected_at, @done_at, @commit_shas, @claimed_by,
                 @claimed_at, @claimed_turn_uuid, @anchor_id,
                 @notes)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           status = excluded.status,
           priority = excluded.priority,
           injected_at = excluded.injected_at,
           done_at = excluded.done_at,
           commit_shas = excluded.commit_shas,
           notes = excluded.notes`,
      )
      .run({
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority ?? 'polish',
        added_at: row.added_at,
        injected_at: row.injected_at ?? null,
        done_at: row.done_at ?? null,
        commit_shas: row.commit_shas ?? null,
        claimed_by: row.claimed_by ?? null,
        claimed_at: row.claimed_at ?? null,
        claimed_turn_uuid: row.claimed_turn_uuid ?? null,
        anchor_id: row.anchor_id ?? null,
        notes: row.notes ?? null,
      });
  }

  getBacklogItem(id: string): BacklogItemRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM lex_backlog_items WHERE id = ?`)
        .get(id) as BacklogItemRow | undefined) ?? null
    );
  }

  listBacklogItems(opts: {
    status?: BacklogItemRow['status'];
    limit?: number;
  } = {}): BacklogItemRow[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    if (opts.status) {
      return this.db
        .prepare(
          `SELECT * FROM lex_backlog_items WHERE status = ?
             ORDER BY added_at DESC LIMIT ?`,
        )
        .all(opts.status, limit) as BacklogItemRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM lex_backlog_items
           ORDER BY added_at DESC LIMIT ?`,
      )
      .all(limit) as BacklogItemRow[];
  }

  /**
   * Atomic claim. Only flips the row to in-flight when:
   *   - the row exists, AND
   *   - status='queued', AND
   *   - claimed_by IS NULL.
   *
   * Returns the number of rows changed (0 or 1). Concurrent
   * callers racing to claim the same id will both fire the
   * UPDATE; only one observes changes=1 because sqlite serialises
   * writers and the WHERE clause re-evaluates on the loser's
   * attempt. Loser observes changes=0 and reports ok=false in the
   * wrapping store.
   */
  claimBacklogItem(opts: {
    id: string;
    claimed_by: string;
    claimed_at: string;
    claimed_turn_uuid: string | null;
    anchor_id: string | null;
    injected_at: string | null;
  }): number {
    const info = this.db
      .prepare(
        `UPDATE lex_backlog_items
           SET status='in-flight',
               claimed_by=@claimed_by,
               claimed_at=@claimed_at,
               claimed_turn_uuid=@claimed_turn_uuid,
               anchor_id=@anchor_id,
               injected_at=COALESCE(injected_at, @injected_at)
         WHERE id=@id
           AND status='queued'
           AND claimed_by IS NULL`,
      )
      .run({
        id: opts.id,
        claimed_by: opts.claimed_by,
        claimed_at: opts.claimed_at,
        claimed_turn_uuid: opts.claimed_turn_uuid,
        anchor_id: opts.anchor_id,
        injected_at: opts.injected_at,
      });
    return info.changes;
  }

  releaseBacklogItem(opts: {
    id: string;
    claimed_by: string;
    target_status: 'queued' | 'parked';
  }): number {
    /* Release only fires when the caller owns the claim. Prevents
     * one worker dropping another's in-flight row by accident. */
    const info = this.db
      .prepare(
        `UPDATE lex_backlog_items
           SET status=@target_status,
               claimed_by=NULL,
               claimed_at=NULL,
               claimed_turn_uuid=NULL
         WHERE id=@id
           AND status='in-flight'
           AND claimed_by=@claimed_by`,
      )
      .run({
        id: opts.id,
        claimed_by: opts.claimed_by,
        target_status: opts.target_status,
      });
    return info.changes;
  }

  markBacklogItemDone(opts: {
    id: string;
    claimed_by: string | null;
    done_at: string;
    commit_shas: string | null;
    notes?: string | null;
  }): number {
    /* Done flip accepts either the owning claimant OR no claim
     * filter (when claimed_by===null) so a re-run can finalise a
     * row whose claim was dropped. The status filter ensures we
     * only retire an in-flight row; already-done rows are no-ops. */
    if (opts.claimed_by) {
      const info = this.db
        .prepare(
          `UPDATE lex_backlog_items
             SET status='done',
                 done_at=@done_at,
                 commit_shas=COALESCE(@commit_shas, commit_shas),
                 notes=COALESCE(@notes, notes)
           WHERE id=@id
             AND status='in-flight'
             AND claimed_by=@claimed_by`,
        )
        .run({
          id: opts.id,
          claimed_by: opts.claimed_by,
          done_at: opts.done_at,
          commit_shas: opts.commit_shas,
          notes: opts.notes ?? null,
        });
      return info.changes;
    }
    const info = this.db
      .prepare(
        `UPDATE lex_backlog_items
           SET status='done',
               done_at=@done_at,
               commit_shas=COALESCE(@commit_shas, commit_shas),
               notes=COALESCE(@notes, notes)
         WHERE id=@id
           AND status='in-flight'`,
      )
      .run({
        id: opts.id,
        done_at: opts.done_at,
        commit_shas: opts.commit_shas,
        notes: opts.notes ?? null,
      });
    return info.changes;
  }

  /* ─── Auto-advance supervisor (migrations 027 + 028) ───────────
   *
   * Phase 3 lands the loop in shadow-only operation. Every decision
   * the supervisor makes lands in auto_advance_log; the lease
   * primitive on project_session prevents two daemons from acting
   * on the same anchor at once.
   */

  insertAutoAdvanceLog(row: AutoAdvanceLogInsert): void {
    this.db
      .prepare(
        `INSERT INTO auto_advance_log
           (id, anchor_id, turn_uuid, item_id, mode, decision,
            reason, would_inject_preview, footer_status,
            footer_needs_attention, epoch)
         VALUES (@id, @anchor_id, @turn_uuid, @item_id, @mode,
                 @decision, @reason, @would_inject_preview,
                 @footer_status, @footer_needs_attention, @epoch)`,
      )
      .run({
        id: row.id,
        anchor_id: row.anchor_id,
        turn_uuid: row.turn_uuid,
        item_id: row.item_id,
        mode: row.mode,
        decision: row.decision,
        reason: row.reason ?? null,
        would_inject_preview: row.would_inject_preview ?? null,
        footer_status: row.footer_status ?? null,
        footer_needs_attention:
          row.footer_needs_attention === undefined ||
          row.footer_needs_attention === null
            ? null
            : row.footer_needs_attention
              ? 1
              : 0,
        epoch: row.epoch ?? null,
      });
  }

  listAutoAdvanceLog(opts: {
    anchor_id?: string;
    mode?: AutoAdvanceLogRow['mode'];
    decision?: AutoAdvanceLogRow['decision'];
    limit?: number;
  } = {}): AutoAdvanceLogRow[] {
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (opts.anchor_id) {
      wheres.push('anchor_id = ?');
      params.push(opts.anchor_id);
    }
    if (opts.mode) {
      wheres.push('mode = ?');
      params.push(opts.mode);
    }
    if (opts.decision) {
      wheres.push('decision = ?');
      params.push(opts.decision);
    }
    const clause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    params.push(limit);
    return this.db
      .prepare(
        `SELECT * FROM auto_advance_log ${clause}
           ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as AutoAdvanceLogRow[];
  }

  /**
   * Atomic lease bump. Succeeds when the row exists and its current
   * owner is either NULL or the supplied owner (re-entry); fails
   * silently when a different owner already holds the lease. The
   * epoch increments on every successful bump so a subsequent
   * writer can detect that it's been superseded. Returns the new
   * epoch on success, null on contention or unknown anchor.
   */
  bumpAutoAdvanceLease(anchorId: string, owner: string): number | null {
    const info = this.db
      .prepare(
        `UPDATE project_session
           SET auto_advance_owner = ?,
               auto_advance_epoch = COALESCE(auto_advance_epoch, 0) + 1
         WHERE id = ?
           AND (auto_advance_owner IS NULL OR auto_advance_owner = ?)`,
      )
      .run(owner, anchorId, owner);
    if (info.changes === 0) return null;
    const row = this.db
      .prepare(
        `SELECT auto_advance_epoch AS epoch FROM project_session WHERE id = ?`,
      )
      .get(anchorId) as { epoch?: number } | undefined;
    return row?.epoch ?? null;
  }

  close(): void {
    this.db.close();
  }
}
