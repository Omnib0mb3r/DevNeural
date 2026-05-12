-- SMART-COMPACT.md wiring follow-up. Adds a full-body payload_text
-- column to smart_compact_log so the SmartCompactAuditPanel can
-- expand a row and show the exact prompt that was queued / fired
-- (the existing summary_preview is capped at 280 chars).
--
-- Nullable + no backfill; older rows render with summary_preview
-- only when expanded, which is acceptable for audit history.

ALTER TABLE smart_compact_log
  ADD COLUMN payload_text TEXT;
