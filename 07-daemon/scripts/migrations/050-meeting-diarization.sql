-- Post-session meeting diarization (2026-07-15).
--
-- brainstorm_chunks (migration 003) carries only turn_index, not a
-- start_ms/end_ms pair; created_at is a wall-clock write timestamp,
-- not an audio-relative offset. There is therefore no reliable way
-- to merge diarize.py's speaker segments onto existing chunk rows by
-- time overlap without guessing an alignment, which the diarization
-- wiring spec explicitly forbids. This table is the source of truth
-- instead: one row per diarized segment parsed from diarize.py's
-- <stem>_diarized.srt output, independent of brainstorm_chunks.
--
-- session_id is a brainstorm_sessions FK (kind='meeting' rows only;
-- enforced in application code the same way meeting_action_items and
-- other meeting-scoped tables do it, since SQLite cannot CHECK against
-- a sibling table's column at insert time).
--
-- speaker is the raw diarize.py / pyannote label (e.g. SPEAKER_00).
-- speaker_guess is a best-effort mapping onto the session's
-- comma-separated attendees list by speaker index order; kept
-- alongside the raw label rather than overwriting it because the
-- ordering guess is frequently wrong (pyannote speaker order has no
-- relation to attendee list order).

CREATE TABLE IF NOT EXISTS meeting_diarization (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  start_ms      INTEGER NOT NULL,
  end_ms        INTEGER NOT NULL,
  speaker       TEXT NOT NULL,
  speaker_guess TEXT,
  text          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (session_id) REFERENCES brainstorm_sessions(id)
);

CREATE INDEX IF NOT EXISTS meeting_diarization_session
  ON meeting_diarization(session_id, start_ms);
