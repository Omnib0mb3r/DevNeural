-- Wave 2 day 1 (CODEX-002 B3 adoption: meeting artifact contract).
--
-- Action items extracted from meeting summaries. Surfaced in
-- MeetingDetailResponse.action_items and seed reminders. Persisted
-- as a first-class table (not as JSON in a meeting summary blob)
-- so dashboards, the reminder system, and the random-artifact
-- sampler can index over them. meeting_id is a voice-session FK
-- with kind='meeting'; the FK is enforced by application-layer
-- gating because SQLite cannot CHECK against a column from another
-- row at insert time.

CREATE TABLE IF NOT EXISTS meeting_action_items (
  id                TEXT PRIMARY KEY,
  meeting_id        TEXT NOT NULL,
  text              TEXT NOT NULL,
  assignee          TEXT,
  due               TEXT,
  reminder_id       TEXT,
  status            TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','done','dismissed','superseded')),
  source_turn_index INTEGER,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at       TEXT,
  FOREIGN KEY (meeting_id) REFERENCES brainstorm_sessions(id)
);

CREATE INDEX IF NOT EXISTS meeting_action_items_meeting
  ON meeting_action_items(meeting_id);
CREATE INDEX IF NOT EXISTS meeting_action_items_status
  ON meeting_action_items(status, due);
