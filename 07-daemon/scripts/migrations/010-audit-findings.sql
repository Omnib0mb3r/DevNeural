-- Wave 2 day 1 prerequisite (CODEX-002 + section 3 / spec 11.W2).
--
-- audit_findings is the cross-source surface that lint, the LLM
-- self-audit, the canary, the schema-regression suite, and the
-- random artifact sampler all write to. The dashboard
-- LintFindingsPanel + Curator Health card both read from here.
--
-- page_slug and brainstorm_id are nullable because not every
-- finding scopes to one of those (canary failures may name a
-- whole-system issue, schema-regression failures name a fixture
-- not a wiki page, etc.).

CREATE TABLE IF NOT EXISTS audit_findings (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('lint','self-audit','canary','user-flag','schema-regression')),
  severity      TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  page_slug     TEXT,
  brainstorm_id TEXT,
  finding       TEXT NOT NULL,
  detail        TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at   TEXT
);

CREATE INDEX IF NOT EXISTS audit_findings_status
  ON audit_findings(status, created_at);
CREATE INDEX IF NOT EXISTS audit_findings_page
  ON audit_findings(page_slug);
CREATE INDEX IF NOT EXISTS audit_findings_source
  ON audit_findings(source, severity, status);
