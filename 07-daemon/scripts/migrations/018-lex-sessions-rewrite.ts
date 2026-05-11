/**
 * Lex session model rewrite (PLAN-lex-session-rewrite.md, step 1 of 6).
 *
 * Decouples Lex brainstorm continuity from Claude Code's session id.
 * Introduces two new tables; the legacy `brainstorm_sessions` table is
 * left in place for now and will be retired in a later migration once
 * call sites have been ported.
 *
 * lex_session  (durable anchor, daemon-owned identity)
 *   id              TEXT PK          uuid; surfaced everywhere as the
 *                                    canonical session id
 *   created_ms      INTEGER NOT NULL
 *   title           TEXT             user-set rename
 *   derived_title   TEXT             llm-derived fallback title
 *   status          TEXT NOT NULL    'live' | 'dormant'
 *                                    (UI derives idle/thinking/tool/
 *                                    permission from the latest
 *                                    transcript jsonl tail when live;
 *                                    only 'dormant' is new)
 *   current_pty_id  TEXT             null when dormant
 *   cwd             TEXT NOT NULL    canonical lex cwd, used at spawn
 *
 * lex_transcript_ref  (ordered list of CC transcripts per anchor)
 *   id               INTEGER PK AUTOINCREMENT
 *   lex_session_id   TEXT NOT NULL FK -> lex_session(id) ON DELETE CASCADE
 *   cc_session_id    TEXT NOT NULL    claude session uuid for this jsonl
 *   transcript_path  TEXT NOT NULL    absolute path to the jsonl
 *   started_ms       INTEGER NOT NULL
 *   ended_ms         INTEGER          null while still live
 *   ordering         INTEGER NOT NULL position within the anchor's
 *                                     history; 0-based, monotonically
 *                                     increasing per anchor
 *
 * Backfill preserves history: every existing brainstorm_sessions row
 * becomes one lex_session row (same id, so foreign keys elsewhere
 * stay valid). Rows with a non-null claude_session_id additionally
 * get one lex_transcript_ref pointing at the existing jsonl path,
 * so reopening a past brainstorm has a transcript to Read.
 *
 * Idempotency: filename guards repeated runs at the migration-runner
 * level. Inserts use INSERT OR IGNORE so a manual partial replay is
 * also safe.
 */
import type Database from 'better-sqlite3';
import * as os from 'node:os';
import * as path from 'node:path';

interface LegacyBrainstormRow {
  id: string;
  claude_session_id: string | null;
  pty_id: string | null;
  cwd: string;
  user_label: string | null;
  derived_label: string | null;
  status: string;
  started_ms: number;
  ended_ms: number | null;
}

function cwdToClaudeSlug(cwd: string): string {
  return cwd.replace(/[\\/:]/g, '-');
}

function transcriptPathFor(cwd: string, ccSessionId: string): string {
  const home = os.homedir().replace(/\\/g, '/');
  const slug = cwdToClaudeSlug(cwd);
  return path.posix.join(home, '.claude', 'projects', slug, `${ccSessionId}.jsonl`);
}

export default function migrate(db: Database.Database): void {
  /* Schema. Foreign-key constraint enforces the parent/child link;
   * the migration runner pragma'd foreign_keys=ON so the constraint
   * is active inside the transaction wrapping this file. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS lex_session (
      id              TEXT PRIMARY KEY,
      created_ms      INTEGER NOT NULL,
      title           TEXT,
      derived_title   TEXT,
      status          TEXT NOT NULL DEFAULT 'dormant',
      current_pty_id  TEXT,
      cwd             TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lex_session_status
      ON lex_session (status, created_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_lex_session_pty
      ON lex_session (current_pty_id);

    CREATE TABLE IF NOT EXISTS lex_transcript_ref (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      lex_session_id   TEXT NOT NULL,
      cc_session_id    TEXT NOT NULL,
      transcript_path  TEXT NOT NULL,
      started_ms       INTEGER NOT NULL,
      ended_ms         INTEGER,
      ordering         INTEGER NOT NULL,
      FOREIGN KEY (lex_session_id) REFERENCES lex_session(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_lex_transcript_ref_session
      ON lex_transcript_ref (lex_session_id, ordering);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_lex_transcript_ref_cc
      ON lex_transcript_ref (cc_session_id);
  `);

  /* Backfill. The legacy brainstorm_sessions table may not exist on
   * a fresh install; guard via sqlite_master. */
  const hasLegacy =
    (db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='brainstorm_sessions'`,
      )
      .get() as { name?: string } | undefined)?.name === 'brainstorm_sessions';
  if (!hasLegacy) {
    process.stderr.write(
      `[018-lex-sessions-rewrite] no legacy brainstorm_sessions table; skipping backfill\n`,
    );
    return;
  }

  const rows = db
    .prepare(
      `SELECT id, claude_session_id, pty_id, cwd, user_label, derived_label,
              status, started_ms, ended_ms
       FROM brainstorm_sessions
       ORDER BY started_ms ASC`,
    )
    .all() as LegacyBrainstormRow[];

  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO lex_session
      (id, created_ms, title, derived_title, status, current_pty_id, cwd)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRef = db.prepare(`
    INSERT OR IGNORE INTO lex_transcript_ref
      (lex_session_id, cc_session_id, transcript_path, started_ms, ended_ms, ordering)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let sessions = 0;
  let refs = 0;
  for (const row of rows) {
    /* Map legacy status onto the new two-state field. Anything that
     * was 'active' AND still bound to a pty becomes 'live' (the
     * continuous reaper will mark it dormant on the next sweep if
     * the pty is gone); everything else is 'dormant'. */
    const status =
      row.status === 'active' && row.pty_id ? 'live' : 'dormant';
    insertSession.run(
      row.id,
      row.started_ms,
      row.user_label,
      row.derived_label,
      status,
      status === 'live' ? row.pty_id : null,
      row.cwd,
    );
    sessions += 1;

    if (row.claude_session_id) {
      const tp = transcriptPathFor(row.cwd, row.claude_session_id);
      insertRef.run(
        row.id,
        row.claude_session_id,
        tp,
        row.started_ms,
        row.ended_ms,
        0,
      );
      refs += 1;
    }
  }
  process.stderr.write(
    `[018-lex-sessions-rewrite] backfilled lex_session=${sessions} lex_transcript_ref=${refs} from legacy brainstorm_sessions\n`,
  );
}
