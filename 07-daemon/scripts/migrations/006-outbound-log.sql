-- PB-2, BF-4: Every off-host call is logged. The privacy invariant
-- is provenance-based, not class-based. A wiki page derived from any
-- voice session (brainstorm or meeting) is just as forbidden off-host
-- as the raw transcript itself.
--
-- Application-level enforcement lives in
-- 07-daemon/src/ingest/pass2.ts and cross-project.ts (Wave 1 day 2
-- step 15). The trigger here is the third line of defence.

CREATE TABLE IF NOT EXISTS outbound_log (
  id                            TEXT PRIMARY KEY,
  destination                   TEXT NOT NULL,
  purpose                       TEXT NOT NULL,
  payload_class                 TEXT NOT NULL,
  contains_voice_session_source INTEGER NOT NULL DEFAULT 0,
  payload_bytes                 INTEGER NOT NULL,
  request_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  response_status               INTEGER,
  response_at                   TEXT,
  error                         TEXT,
  failure_code                  TEXT
);

CREATE INDEX IF NOT EXISTS outbound_log_day ON outbound_log(request_at);

-- Enforce: no voice-session class AND no voice-session-derived
-- provenance ever leave the host.
CREATE TRIGGER IF NOT EXISTS outbound_no_voice_session
BEFORE INSERT ON outbound_log
FOR EACH ROW
WHEN (NEW.payload_class LIKE 'brainstorm-%')
   OR (NEW.payload_class LIKE 'meeting-%')
   OR (NEW.contains_voice_session_source = 1)
BEGIN
  SELECT RAISE(ABORT, 'voice-session content (brainstorm or meeting) or voice-session-derived content cannot be sent off-host (PB-4)');
END;
