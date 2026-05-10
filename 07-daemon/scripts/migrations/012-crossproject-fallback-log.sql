-- Wave 2 day 1 (CP-1 fallback audit log).
--
-- Records every cross-project promotion candidate that hit the
-- no-tags fallback (DEVNEURAL_CROSSPROJECT_FALLBACK_NO_TAGS).
-- Default config is `block` so this table stays empty. The
-- `permissive` mode logs each fallback decision here so the user
-- can review which cross-project pages were promoted without the
-- domain-distance gate.

CREATE TABLE IF NOT EXISTS crossproject_fallback_log (
  id                     TEXT PRIMARY KEY,
  candidate_slug         TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  participating_projects TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS crossproject_fallback_log_day
  ON crossproject_fallback_log(created_at);
CREATE INDEX IF NOT EXISTS crossproject_fallback_log_candidate
  ON crossproject_fallback_log(candidate_slug);
