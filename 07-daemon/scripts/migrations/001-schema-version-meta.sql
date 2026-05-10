-- WI-1: Schema versioning infrastructure.
--
-- _migrations is created by the runner itself; this file adds the
-- companion wiki_meta table that tracks per-page schema_version
-- counters and any other wiki-scope key/value bookkeeping that does
-- not belong in frontmatter.

CREATE TABLE IF NOT EXISTS wiki_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO wiki_meta (key, value)
VALUES ('frontmatter_schema_version', '2');
