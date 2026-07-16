/**
 * Brainstorm KPI computation (2026-07-16 operator audit: the home
 * KPI tiles for artifacts-per-brainstorm and wiki lineage coverage
 * said "pending" forever because the route hardcoded both to 0).
 *
 * Definitions:
 *   artifacts_per_brainstorm_avg - wiki drafts produced per brainstorm
 *     session (wiki_drafts is the artifact record a brainstorm leaves
 *     behind; every draft row carries its source brainstorm_id).
 *   wiki_lineage_coverage - fraction of brainstorm sessions that
 *     produced at least one wiki draft, i.e. how much of the spoken
 *     record has wiki lineage.
 */
import type { IndexDb } from '../store/index-db.js';

export interface BrainstormKpis {
  total_brainstorms: number;
  hours_captured: number;
  artifacts_per_brainstorm_avg: number;
  wiki_lineage_coverage: number;
  project_less_ratio: number;
  active_today: number;
}

export function computeBrainstormKpis(db: IndexDb): BrainstormKpis {
  const raw = (
    db as unknown as {
      db: {
        prepare: (s: string) => { get: () => Record<string, number | null> };
      };
    }
  ).db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM brainstorm_sessions
           WHERE COALESCE(kind, 'brainstorm') = 'brainstorm')      AS total,
         (SELECT SUM(CASE WHEN ended_ms IS NOT NULL
                          THEN (ended_ms - started_ms) / 1000.0
                          ELSE 0 END) / 3600.0
            FROM brainstorm_sessions
           WHERE COALESCE(kind, 'brainstorm') = 'brainstorm')      AS hours,
         (SELECT SUM(CASE WHEN project_slug IS NULL THEN 1 ELSE 0 END)
            FROM brainstorm_sessions
           WHERE COALESCE(kind, 'brainstorm') = 'brainstorm')      AS project_less,
         (SELECT COUNT(*) FROM brainstorm_sessions
           WHERE COALESCE(kind, 'brainstorm') = 'brainstorm'
             AND substr(strftime('%Y-%m-%dT%H:%M:%SZ', started_ms / 1000.0, 'unixepoch'), 1, 10)
                 = strftime('%Y-%m-%d', 'now'))                    AS active_today,
         (SELECT COUNT(*) FROM wiki_drafts)                        AS drafts_total,
         (SELECT COUNT(DISTINCT brainstorm_id) FROM wiki_drafts
           WHERE brainstorm_id IS NOT NULL)                        AS brainstorms_with_drafts`,
    )
    .get();
  const total = Number(raw.total ?? 0);
  const draftsTotal = Number(raw.drafts_total ?? 0);
  const withDrafts = Number(raw.brainstorms_with_drafts ?? 0);
  return {
    total_brainstorms: total,
    hours_captured: Number(raw.hours ?? 0),
    artifacts_per_brainstorm_avg: total > 0 ? draftsTotal / total : 0,
    wiki_lineage_coverage: total > 0 ? Math.min(1, withDrafts / total) : 0,
    project_less_ratio: total > 0 ? Number(raw.project_less ?? 0) / total : 0,
    active_today: Number(raw.active_today ?? 0),
  };
}
