-- Lex backlog migration (autonomous supervisor phase 2).
--
-- Lex's backlog lived in c:/tmp/lex-backlog-queue.json, which both
-- Lex and the daemon read + write. File-CAS on Windows across two
-- processes is fragile (last-writer-wins eats concurrent edits)
-- and restart recovery requires re-parsing a file that may be
-- mid-write. Move the canonical store into sqlite so the daemon's
-- atomic claim primitive can guarantee single-claim semantics
-- without an ad-hoc lock file.
--
-- The seed script (scripts/seed-lex-backlog.ts) does a one-shot
-- import from the legacy JSON queue; subsequent edits go through
-- the REST surface in dashboard/routes.ts -> backlog-store.ts.

CREATE TABLE IF NOT EXISTS lex_backlog_items (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL
                     CHECK(status IN ('queued','in-flight','done','parked')),
  priority           TEXT NOT NULL DEFAULT 'polish',
  added_at           TEXT NOT NULL,
  injected_at        TEXT,
  done_at            TEXT,
  /* JSON array of short SHAs landed for this item. Stored as TEXT
   * so consumers can parse / push without touching the schema. */
  commit_shas        TEXT,
  claimed_by         TEXT,
  claimed_at         TEXT,
  claimed_turn_uuid  TEXT,
  /* References lex_session(id) (the canonical anchor table after
   * migration 018; brainstorm_sessions stays the legacy mirror).
   * ON DELETE SET NULL so removing an anchor leaves its backlog
   * rows discoverable rather than cascading them away. */
  anchor_id          TEXT REFERENCES lex_session(id) ON DELETE SET NULL,
  notes              TEXT
);

/* Partial unique index documenting the dupe-claim guard the
 * atomic claim primitive enforces in code. The PRIMARY KEY on id
 * already prevents two rows with the same id, so this index is
 * strictly belt-and-suspenders: any future code path that
 * accidentally inserts a duplicate in-flight row breaks here
 * rather than silently double-claiming. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_lex_backlog_inflight_unique
  ON lex_backlog_items(id)
  WHERE status = 'in-flight';

CREATE INDEX IF NOT EXISTS idx_lex_backlog_status_added
  ON lex_backlog_items(status, added_at);

CREATE INDEX IF NOT EXISTS idx_lex_backlog_anchor
  ON lex_backlog_items(anchor_id);
