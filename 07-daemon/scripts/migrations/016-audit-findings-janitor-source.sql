-- Wave 3 Lane B step 37 (LX-14). Extend audit_findings source enum to
-- include 'janitor' for memory-janitor consolidation findings.
--
-- SQLite does not support ALTER COLUMN, so we use the standard rename-
-- recreate-copy-drop pattern. The new CHECK constraint covers all prior
-- sources plus 'janitor'.

-- Step 1: rename the existing table.
ALTER TABLE audit_findings RENAME TO audit_findings_old_016;

-- Step 2: create the new table with the extended CHECK constraint.
CREATE TABLE audit_findings (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('lint','self-audit','canary','user-flag','schema-regression','janitor')),
  severity      TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  page_slug     TEXT,
  brainstorm_id TEXT,
  finding       TEXT NOT NULL,
  detail        TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at   TEXT
);

-- Step 3: copy all rows from the old table.
INSERT INTO audit_findings SELECT * FROM audit_findings_old_016;

-- Step 4: drop the old table.
DROP TABLE audit_findings_old_016;

-- Step 5: recreate indexes (they were dropped with the old table).
CREATE INDEX IF NOT EXISTS audit_findings_status
  ON audit_findings(status, created_at);
CREATE INDEX IF NOT EXISTS audit_findings_page
  ON audit_findings(page_slug);
CREATE INDEX IF NOT EXISTS audit_findings_source
  ON audit_findings(source, severity, status);
