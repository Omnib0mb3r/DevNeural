-- Lex standalone supervision (2026-05-24).
--
-- See docs/spec/LEX-STANDALONE-SUPERVISION.md. The brainstorm row is
-- the durable Lex brain (migration 033). This migration adds the
-- columns the idle-watcher + grooming pipeline need to decide when to
-- fire a pass and what kind of pass last ran.
--
-- Columns added:
--   last_user_utterance_at      ISO timestamp of the most recent user
--                               turn in this brainstorm. The voice WS
--                               updates this on every utterance. The
--                               idle-watcher subtracts now-from-this
--                               to decide which grooming threshold
--                               (5 min / 20 min / 60 min / 6 h) the
--                               row has crossed.
--
--   last_grooming_pass_at       ISO timestamp of the most recent
--                               completed grooming pass. NULL on rows
--                               that have never been groomed. The
--                               watcher uses (now - last_grooming) AND
--                               (now - last_utterance) to decide
--                               whether to escalate; both must clear
--                               the threshold so a freshly-groomed row
--                               does not re-fire immediately.
--
--   last_grooming_kind          'light' | 'mid' | 'cold' | 'day-cap'.
--                               NULL on rows that have never been
--                               groomed. Surfaces in the dashboard
--                               panel so the operator can see what
--                               level of pass each idle row most
--                               recently received.
--
-- All three columns are nullable; legacy rows backfill to NULL and
-- the idle-watcher treats NULL last_user_utterance_at as "use
-- started_ms as the clock baseline". No backfill SQL needed for the
-- two grooming columns; first pass populates them.

ALTER TABLE brainstorm_sessions ADD COLUMN last_user_utterance_at TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN last_grooming_pass_at  TEXT;
ALTER TABLE brainstorm_sessions ADD COLUMN last_grooming_kind     TEXT;

-- Index for the idle-watcher's primary query: every row with
-- lifecycle_state IN ('idle','attached') ordered by last_utterance so
-- the oldest gaps surface first.
CREATE INDEX IF NOT EXISTS idx_brainstorm_idle_watch
  ON brainstorm_sessions (lifecycle_state, last_user_utterance_at);
