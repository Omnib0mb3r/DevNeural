-- Control-transport fix (2026-07-14): widen
-- cross_session_injection_log.decision CHECK to accept
-- 'rejected_scope'.
--
-- crossSessionInject's worker-scope gate (2026-07-08) has been
-- writing decision='rejected_scope' audit rows since it shipped, but
-- the CHECK constraint was never widened to accept the value, so
-- every one of those inserts has been silently swallowed by
-- insertCrossSessionLog's try/catch (table exists, CHECK fails,
-- error discarded). The four operator-path routes (/lex/steer,
-- /sessions/:id/prompt, /sessions/:id/suggest, /sessions/:id/inject)
-- now write the same decision on their own scope rejection, so this
-- gap has to close first or the new audit rows land just as
-- invisibly as the old ones.
--
-- SQLite cannot ALTER CHECK in place, so rebuild and copy. Column set
-- tracks migration 032 (adds no_deliverable_bridge, keeps
-- payload_text).

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
                   'no_deliverable_bridge',
                   'rejected_scope'
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
