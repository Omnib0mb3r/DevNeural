-- SMART-COMPACT.md step "Audit". One row per smart-compact decision:
-- evaluate calls log when they decide to act, fire calls log when they
-- execute (or stay in shadow mode), wrap calls log the wrap-and-commit
-- injection. The dashboard panel surfaces a timeline so the operator
-- can see auto-compactions and tune thresholds.

CREATE TABLE IF NOT EXISTS smart_compact_log (
  id               TEXT PRIMARY KEY,
  ts               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  anchor_id        TEXT,
  cc_session_id    TEXT,
  caller           TEXT NOT NULL,
  -- Why the action fired (see smart-compact.ts):
  --   window-open      window AND stop point both hit
  --   forced-no-stop   window passed without a stop, wrap-and-commit
  --                    prompt injected (action='wrap')
  --   hard-ceiling     ctx_pct >= 90, compact regardless of stop
  --   shadow           shadow mode trial, no inject
  --   manual           dashboard / operator-driven
  reason           TEXT NOT NULL,
  -- What we did:
  --   fire     /clear + resume summary injected
  --   wrap     wrap-and-commit prompt injected, waiting for ready
  --   shadow   audit-only; no inject
  --   noop     evaluator said wait (logged only on explicit request)
  action           TEXT NOT NULL
                     CHECK (action IN ('fire','wrap','shadow','noop')),
  pre_ctx_pct      REAL,
  post_ctx_pct     REAL,
  -- First 280 chars of the resume prompt, kept short for the dashboard
  -- audit panel. Full prompts can always be reconstructed from the
  -- assembler given the anchor + ts.
  summary_preview  TEXT
);

CREATE INDEX IF NOT EXISTS ix_smart_compact_log_ts
  ON smart_compact_log(ts DESC);
CREATE INDEX IF NOT EXISTS ix_smart_compact_log_anchor_ts
  ON smart_compact_log(anchor_id, ts DESC);
