-- Wave 3 Lane B step 38 (LX-15).  Cross-session prompt injection audit log.
--
-- Records every injection attempt made via POST /lex/inject-cross-session so
-- the operator can audit what was injected, from which caller, into which
-- session, and whether it was accepted or rejected.
--
-- Auth model: caller supplies an HMAC token derived from the dashboard PIN
-- (same secret root) keyed on the target_session value and the current
-- UNIX-minute (token valid for 2 minutes).  The allowlist is checked before
-- the HMAC so a rejected session never reaches the crypto path.

CREATE TABLE IF NOT EXISTS cross_session_injection_log (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  target_session TEXT NOT NULL,
  caller_label TEXT,
  text_preview TEXT NOT NULL,
  text_length  INTEGER NOT NULL,
  decision     TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected_auth', 'rejected_allowlist', 'rejected_pty')),
  reject_reason TEXT,
  brainstorm_id TEXT
);

CREATE INDEX IF NOT EXISTS ix_csil_ts             ON cross_session_injection_log(ts);
CREATE INDEX IF NOT EXISTS ix_csil_target_ts      ON cross_session_injection_log(target_session, ts);
CREATE INDEX IF NOT EXISTS ix_csil_decision_ts    ON cross_session_injection_log(decision, ts);
