-- Wave 2 day 1 (BF-13 backfill manual review queue).
--
-- Holds (page, brainstorm) candidate pairs from
-- npm run backfill-brainstorms with their cosine and band:
--   high       (cosine >= 0.85): auto-link, write source_brainstorms
--   borderline (0.65 .. 0.85):    surface in /brainstorms/backfill-review
--                                  for one-click link or reject
--   low        (< 0.65):          ignore, never link
-- The dashboard route empties the queue manually (status=linked or
-- rejected) until status=pending count = 0 OR the user dismisses.

CREATE TABLE IF NOT EXISTS backfill_review_queue (
  id                  TEXT PRIMARY KEY,
  brainstorm_id       TEXT NOT NULL,
  candidate_page_slug TEXT NOT NULL,
  cosine              REAL NOT NULL,
  band                TEXT NOT NULL CHECK (band IN ('high','borderline','low')),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','linked','rejected','skipped')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at         TEXT,
  resolved_by         TEXT
);

CREATE INDEX IF NOT EXISTS backfill_review_queue_status
  ON backfill_review_queue(status, band);
CREATE INDEX IF NOT EXISTS backfill_review_queue_brainstorm
  ON backfill_review_queue(brainstorm_id);
