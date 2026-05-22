-- Bug 3e (2026-05-22): widen cross_session_injection_log.decision
-- CHECK constraint to accept 'no_deliverable_bridge'. The daemon
-- emits this verdict when the bridge fallback would have written a
-- marker into a file that no terminal-owning bridge is currently
-- claiming. The audit row gives Lex (and the operator) a real
-- failure signal instead of a false-positive 'accepted'. See
-- docs/bugs/2026-05-22-worker-discovery-both-launch-paths.md and
-- docs/bugs/2026-05-22-lex-blind-to-worker-on-cold-start.md.
--
-- SQLite cannot ALTER CHECK in place, so rebuild and copy. Column
-- set tracks migration 029 plus migration 030's payload_text;
-- dropping payload_text here would silently break Fix 15 C3 parked
-- inject replay.

CREATE TABLE cross_session_injection_log_new (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  target_session TEXT NOT NULL,
  caller_label   TEXT,
  text_preview   TEXT NOT NULL,
  text_length    INTEGER NOT NULL,
  decision       TEXT NOT NULL CHECK(decision IN (
                   'accepted',
                   'rejected_auth',
                   'rejected_allowlist',
                   'rejected_pty',
                   'shadow',
                   'redirected',
                   'dispatched_dead_session',
                   'rejected_anchor_dormant',
                   'no_deliverable_bridge'
                 )),
  reject_reason  TEXT,
  brainstorm_id  TEXT,
  payload_text   TEXT
);

INSERT INTO cross_session_injection_log_new
  (id, ts, target_session, caller_label, text_preview, text_length, decision, reject_reason, brainstorm_id, payload_text)
SELECT id, ts, target_session, caller_label, text_preview, text_length, decision, reject_reason, brainstorm_id, payload_text
  FROM cross_session_injection_log;

DROP TABLE cross_session_injection_log;
ALTER TABLE cross_session_injection_log_new RENAME TO cross_session_injection_log;

CREATE INDEX IF NOT EXISTS ix_csil_ts          ON cross_session_injection_log(ts);
CREATE INDEX IF NOT EXISTS ix_csil_target_ts   ON cross_session_injection_log(target_session, ts);
CREATE INDEX IF NOT EXISTS ix_csil_decision_ts ON cross_session_injection_log(decision, ts);
