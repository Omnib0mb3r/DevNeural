-- Fix 41 Stage 1: extend smart_compact_log.action CHECK constraint to
-- accept the two new policy-out endpoint actions:
--
--   clear-and-paste   POST /lex/smart-compact/clear-and-paste fired
--                     (Lex-authored summary; daemon ran /clear + paste).
--   wrap-paste        POST /lex/smart-compact/wrap-paste fired
--                     (Lex-authored wrap prompt; daemon injected the
--                     caller-supplied text, no daemon-side constant).
--
-- The legacy values ('fire','wrap','shadow','noop') still pass; the
-- scheduler-driven path keeps using them through Stage 2's
-- short-circuit window. SQLite cannot ALTER CHECK in place, so the
-- table is rebuilt and rows are copied verbatim.

CREATE TABLE smart_compact_log_new (
  id               TEXT PRIMARY KEY,
  ts               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  anchor_id        TEXT,
  cc_session_id    TEXT,
  caller           TEXT NOT NULL,
  reason           TEXT NOT NULL,
  action           TEXT NOT NULL
                     CHECK (action IN (
                       'fire',
                       'wrap',
                       'shadow',
                       'noop',
                       'clear-and-paste',
                       'wrap-paste'
                     )),
  pre_ctx_pct      REAL,
  post_ctx_pct     REAL,
  summary_preview  TEXT,
  payload_text     TEXT
);

INSERT INTO smart_compact_log_new
  (id, ts, anchor_id, cc_session_id, caller, reason, action,
   pre_ctx_pct, post_ctx_pct, summary_preview, payload_text)
SELECT id, ts, anchor_id, cc_session_id, caller, reason, action,
       pre_ctx_pct, post_ctx_pct, summary_preview, payload_text
  FROM smart_compact_log;

DROP TABLE smart_compact_log;
ALTER TABLE smart_compact_log_new RENAME TO smart_compact_log;

CREATE INDEX IF NOT EXISTS ix_smart_compact_log_ts
  ON smart_compact_log(ts DESC);
CREATE INDEX IF NOT EXISTS ix_smart_compact_log_anchor_ts
  ON smart_compact_log(anchor_id, ts DESC);
