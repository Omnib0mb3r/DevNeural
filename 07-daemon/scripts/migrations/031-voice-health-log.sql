-- Dashboard-side voice-output watchdog telemetry sink.
--
-- The dashboard runs a 10s loop that probes the TTS audio path
-- (AudioContext state, BufferSource queue health, last-frame
-- timestamp). On any check failure the client self-heals
-- (resume / close+warm / reattach sink) and ships a row here so
-- the operator can see, after the fact, why voice went dead and
-- whether the watchdog actually recovered without their input.
--
-- One row per failure-or-heal event. Successful idle checks are
-- not logged; they would dwarf the interesting rows. heal_attempt
-- 0 means "check failed before any heal ran"; 1 or 2 means the row
-- describes the outcome of the Nth heal attempt. recovered=1
-- means the immediately-following check confirmed the heal worked.

CREATE TABLE voice_health_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms        INTEGER NOT NULL,
  check_kind   TEXT NOT NULL,
  status       TEXT NOT NULL,
  heal_attempt INTEGER NOT NULL DEFAULT 0,
  recovered    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ix_voice_health_ts ON voice_health_log(ts_ms DESC);
