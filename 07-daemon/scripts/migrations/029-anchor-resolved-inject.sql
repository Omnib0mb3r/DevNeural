-- Fix 15: anchor-resolved cross-session inject dispatch.
--
-- Two structural additions so the daemon can map a stale CC session
-- uuid back to its project anchor and decide whether to redirect to
-- the live session, park for the next live session, or reject.
--
--  1. project_session.previous_session_id
--     Holds the prior current_session_id whenever bridge-presence
--     flips the anchor to a new uuid (or back to dormant). Lets
--     /lex/inject-cross-session ask "does this stale uuid belong to
--     any anchor I know about?" without a separate history table.
--
--  2. cross_session_injection_log.decision CHECK widened to include
--       'redirected'             — inject targeted a dead uuid but
--                                  the anchor was live under a new
--                                  uuid; dispatched to the new one.
--       'dispatched_dead_session' — target_session was a stale uuid
--                                  whose owning anchor is now dormant
--                                  (no current_session_id). Inject
--                                  parked; smart-compact resume will
--                                  replay it when the anchor revives.
--       'rejected_anchor_dormant' — explicit reject for callers that
--                                  asked for a dormant anchor.

ALTER TABLE project_session ADD COLUMN previous_session_id TEXT;

-- SQLite cannot ALTER CHECK in place, so rebuild the table.
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
                   'rejected_anchor_dormant'
                 )),
  reject_reason  TEXT,
  brainstorm_id  TEXT
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
