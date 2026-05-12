-- PANIC-BUTTON.md step 3. Audit log for every panic-button fire.
--
-- Every press of the dashboard panic button, every Ctrl+Alt+. keybind,
-- and every Lex `panic(target?)` tool call writes one row here so the
-- operator can audit what got interrupted, by whom, and whether the
-- inject reached a live PTY.
--
-- result vocabulary:
--   accepted        the \x1b\x1b raw inject made it into a live PTY
--   pty_not_found   anchor resolved but its current_pty_id was stale
--                   or missing in the pty-host map
--   no_target       no live anchor matched the single-target rule

CREATE TABLE IF NOT EXISTS panic_log (
  id                TEXT PRIMARY KEY,
  ts                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  target_anchor_id  TEXT,
  target_pty_id     TEXT,
  target_session_id TEXT,
  clicked_ms        INTEGER NOT NULL,
  caller            TEXT NOT NULL,
  result            TEXT NOT NULL
                      CHECK (result IN ('accepted','pty_not_found','no_target'))
);

CREATE INDEX IF NOT EXISTS ix_panic_log_ts ON panic_log(ts DESC);
CREATE INDEX IF NOT EXISTS ix_panic_log_anchor_ts
  ON panic_log(target_anchor_id, ts DESC);
