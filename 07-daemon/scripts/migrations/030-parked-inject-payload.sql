-- Fix 15 C3 — smart-compact resume replays parked injects.
--
-- When /lex/inject-cross-session rejects with
-- decision='dispatched_dead_session' (anchor went dormant between
-- the caller's send and the daemon's dispatch), smart-compact's
-- resume hook needs to replay the inject when the anchor revives.
-- The existing text_preview column truncates at 120 chars, so replay
-- has nothing useful to re-send. This adds a nullable full-text
-- column populated only when the audit row is destined for replay
-- (decision='dispatched_dead_session'). Other decisions leave it
-- NULL to keep storage bounded.

ALTER TABLE cross_session_injection_log
  ADD COLUMN payload_text TEXT;
