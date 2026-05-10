-- Wave 2 day 1 (OP-1 / heartbeat).
--
-- Daemon-side row written every heartbeat tick (default 60s).
-- The companion external watcher service (07-daemon/heartbeat-
-- watcher/) keeps its own last-beat timestamp; this table is the
-- authoritative log of what the daemon attempted, including
-- watcher acks and watcher-initiated alarms when a beat misses.

CREATE TABLE IF NOT EXISTS heartbeat_log (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  daemon_pid     INTEGER NOT NULL,
  daemon_version TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('posted','ack','no-ack','watcher-alarm')),
  detail         TEXT
);

CREATE INDEX IF NOT EXISTS heartbeat_log_ts
  ON heartbeat_log(ts);
CREATE INDEX IF NOT EXISTS heartbeat_log_status
  ON heartbeat_log(status, ts);
