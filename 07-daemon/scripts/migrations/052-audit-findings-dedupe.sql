-- Audit-findings dedupe backfill (2026-07-16 operator audit).
--
-- 6,972 of 6,993 open findings were ONE lint finding ("archive
-- pending stale") duplicated daily since June 3: the content-derived
-- finding id hashed the raw detail text, whose day counter ("pending
-- 73d, no hits") increments every run, minting a fresh id per day per
-- page. The id derivation is fixed in code (digits normalized out of
-- the hash); this backfill collapses the accumulated duplicates by
-- resolving all but the NEWEST open lint finding per (page_slug,
-- finding). Janitor / self-audit / user-flag rows are untouched -
-- their volume is small and each row is individually meaningful.
UPDATE audit_findings
   SET status = 'resolved',
       resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status = 'open'
   AND source = 'lint'
   AND id NOT IN (
     SELECT id FROM (
       SELECT id,
              ROW_NUMBER() OVER (
                PARTITION BY page_slug, finding
                ORDER BY created_at DESC
              ) AS rn
         FROM audit_findings
        WHERE status = 'open' AND source = 'lint'
     )
     WHERE rn = 1
   );
