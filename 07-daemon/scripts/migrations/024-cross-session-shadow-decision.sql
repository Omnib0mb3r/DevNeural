-- Cold-start preload shadow mode (smart-compact precedent).
--
-- Widens the cross_session_injection_log.decision CHECK constraint to
-- accept 'shadow' so the cold-start preload route can land an audit
-- row for would-have-injected previews without flipping the live path.
-- Mirrors smart_compact_log.action='shadow' semantics: operator can
-- observe what the feature would do before enabling it.
--
-- SQLite does not let us ALTER CHECK in place, so rebuild the table
-- and copy rows across. All other column shapes preserved; indices
-- recreated to match migration 017.

CREATE TABLE cross_session_injection_log_new (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  target_session TEXT NOT NULL,
  caller_label TEXT,
  text_preview TEXT NOT NULL,
  text_length  INTEGER NOT NULL,
  decision     TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected_auth', 'rejected_allowlist', 'rejected_pty', 'shadow')),
  reject_reason TEXT,
  brainstorm_id TEXT
);

INSERT INTO cross_session_injection_log_new
  (id, ts, target_session, caller_label, text_preview, text_length, decision, reject_reason, brainstorm_id)
SELECT id, ts, target_session, caller_label, text_preview, text_length, decision, reject_reason, brainstorm_id
  FROM cross_session_injection_log;

DROP TABLE cross_session_injection_log;
ALTER TABLE cross_session_injection_log_new RENAME TO cross_session_injection_log;

CREATE INDEX IF NOT EXISTS ix_csil_ts          ON cross_session_injection_log(ts);
CREATE INDEX IF NOT EXISTS ix_csil_target_ts   ON cross_session_injection_log(target_session, ts);
CREATE INDEX IF NOT EXISTS ix_csil_decision_ts ON cross_session_injection_log(decision, ts);
