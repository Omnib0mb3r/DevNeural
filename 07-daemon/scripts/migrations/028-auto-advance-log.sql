-- Autonomous supervisor phase 3 audit log.
--
-- One row per auto-advance decision. Shadow-mode runs land here
-- without an inject; live-mode runs land here AND fire a
-- crossSessionInject with caller_label='auto-supervisor'. Reviewer
-- queries:
--
--   SELECT * FROM auto_advance_log WHERE mode='shadow'
--     ORDER BY created_at DESC LIMIT 50;
--
--   -- "did we ever try to advance anchor X and miss?"
--   SELECT * FROM auto_advance_log WHERE anchor_id=?
--     ORDER BY created_at DESC;

CREATE TABLE IF NOT EXISTS auto_advance_log (
  id                     TEXT PRIMARY KEY,
  created_at             TEXT NOT NULL
                         DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  /* Anchor we considered. References project_session(id) when set;
   * NULL only on a tick-level error log. */
  anchor_id              TEXT REFERENCES project_session(id) ON DELETE SET NULL,
  /* The terminal assistant turn uuid the footer was attached to.
   * Acts as the idempotency key together with anchor_id: the loop
   * refuses to fire twice on the same completed turn. */
  turn_uuid              TEXT,
  /* Backlog item id the loop CLAIMED (or attempted to claim).
   * NULL when the loop bailed before reaching the claim phase. */
  item_id                TEXT,
  /* Mode the loop was running in at decision time. */
  mode                   TEXT NOT NULL
                         CHECK(mode IN ('off','shadow','live')),
  /* What the loop decided to do.
   *   shadow         -- shadow-mode log, no inject
   *   accepted       -- live-mode log, crossSessionInject accepted
   *   would-inject   -- shadow-mode "we would have fired"
   *   skip           -- bailed at a gate (footer missing, needs_input, etc)
   *   error          -- caught throw inside the tick */
  decision               TEXT NOT NULL,
  /* Why we skipped (when decision='skip') or errored (when
   * decision='error'). Stable string set; consumers branch on it. */
  reason                 TEXT,
  /* First 280 chars of the would-be inject payload, captured so
   * shadow review can audit prompt shape without storing the
   * whole backlog title. */
  would_inject_preview   TEXT,
  /* The footer's reported status / needs_attention so the panel
   * can render the decision context at-a-glance. */
  footer_status          TEXT,
  footer_needs_attention INTEGER,
  /* Stamped from project_session.auto_advance_epoch at decision
   * time so a future writer that bumped the epoch can be
   * recognised as stale. */
  epoch                  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_auto_advance_log_anchor_created
  ON auto_advance_log (anchor_id, created_at);

CREATE INDEX IF NOT EXISTS idx_auto_advance_log_mode_created
  ON auto_advance_log (mode, created_at);
