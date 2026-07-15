-- Control-transport fix (2026-07-14): widen panic_log.result CHECK to
-- accept 'bridge_esc'.
--
-- Bridge-attached workers (project_session.current_pty_id null,
-- current_bridge_id set) have no daemon-owned PTY to write \x1b\x1b
-- into, so the panic-button fire fell through to the raw PTY
-- injector and always logged 'pty_not_found' even though the worker
-- was live and reachable over the VS Code bridge. panic-routes.ts
-- now retries a PTY miss through the bridge's suggestion queue
-- (commit:false, same 2-char ESC ESC payload the bridge ships
-- unwrapped since it is under the bracketed-paste threshold) and
-- records the outcome as 'bridge_esc' so the audit trail tells the
-- two transports apart.
--
-- SQLite cannot ALTER CHECK in place, so rebuild and copy (same
-- pattern used for cross_session_injection_log in migrations 029/032).

CREATE TABLE panic_log_new (
  id                TEXT PRIMARY KEY,
  ts                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  target_anchor_id  TEXT,
  target_pty_id     TEXT,
  target_session_id TEXT,
  clicked_ms        INTEGER NOT NULL,
  caller            TEXT NOT NULL,
  result            TEXT NOT NULL
                      CHECK (result IN ('accepted','pty_not_found','no_target','bridge_esc'))
);

INSERT INTO panic_log_new
  (id, ts, target_anchor_id, target_pty_id, target_session_id, clicked_ms, caller, result)
SELECT id, ts, target_anchor_id, target_pty_id, target_session_id, clicked_ms, caller, result
  FROM panic_log;

DROP TABLE panic_log;
ALTER TABLE panic_log_new RENAME TO panic_log;

CREATE INDEX IF NOT EXISTS ix_panic_log_ts ON panic_log(ts DESC);
CREATE INDEX IF NOT EXISTS ix_panic_log_anchor_ts
  ON panic_log(target_anchor_id, ts DESC);
